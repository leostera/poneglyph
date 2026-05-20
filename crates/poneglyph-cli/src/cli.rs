use std::path::PathBuf;
use std::sync::OnceLock;

use anyhow::Result;
use clap::{Args, Parser, Subcommand};
use dotenvy::dotenv;
use poneglyph_core::{
    Fact, Filter, SchemaDefinition, Uri, Value, Workspace, default_workspace_path,
};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

use crate::client::{daemon_client, open_runtime};
use crate::cmd;
use crate::config::PoneglyphDaemonConfig;
use poneglyph_api::proto::{
    GetEntityRequest, GetSchemaRequest, QueryRequest, RetractFactByIdRequest, StateFactRequest,
    StateFactsRequest,
};

const DEFAULT_LOG_LEVEL: &str = "info";

#[derive(Debug, Parser)]
#[command(name = "poneglyph")]
#[command(about = "Poneglyph semantic graph database CLI")]
pub struct Cli {
    /// Override the workspace root. Defaults to ~/.poneglyph.
    #[arg(long, default_value_os_t = default_workspace_path())]
    pub workspace: PathBuf,

    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Clone, Subcommand)]
pub enum Command {
    /// Manage the local Poneglyph daemon.
    Server(Server),
    /// Inspect and update local configuration.
    Config(ConfigCommand),
    /// Manage graph schemas.
    Schema(SchemaCommand),
    /// State and retract facts.
    Fact(FactCommand),
    /// Query the active graph with Datalog.
    Query(QueryCommand),
    /// Inspect consolidated entities.
    Entity(EntityCommand),
}

#[derive(Debug, Clone, Args)]
pub struct Server {
    #[command(subcommand)]
    pub command: Option<ServerCommand>,
}

#[derive(Debug, Clone, Subcommand)]
pub enum ServerCommand {
    /// Start the daemon in the foreground.
    Start(cmd::Run),
    /// Repair the database.
    Repair(cmd::Repair),
    /// Print daemon status.
    Status {
        /// Print machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
    /// Stop the daemon.
    Stop {
        /// Print machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
    /// Restart the daemon.
    Restart {
        /// Print machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Clone, Args)]
pub struct ConfigCommand {
    #[command(subcommand)]
    pub command: ConfigSubcommand,
}

#[derive(Debug, Clone, Subcommand)]
pub enum ConfigSubcommand {
    List {
        /// Print machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
    Get {
        key: String,
    },
    Set {
        key: String,
        value: String,
    },
}

#[derive(Debug, Clone, Args)]
pub struct SchemaCommand {
    #[command(subcommand)]
    pub command: SchemaSubcommand,
}

#[derive(Debug, Clone, Subcommand)]
pub enum SchemaSubcommand {
    List,
    Get { uri: Option<String> },
    Apply { path: PathBuf },
}

#[derive(Debug, Clone, Args)]
pub struct FactCommand {
    #[command(subcommand)]
    pub command: FactSubcommand,
}

#[derive(Debug, Clone, Subcommand)]
pub enum FactSubcommand {
    State {
        entity: String,
        attribute: String,
        value: String,
        #[arg(long)]
        source: Option<String>,
        #[arg(long)]
        json: bool,
    },
    Retract {
        #[arg(long)]
        fact: Option<String>,
        #[arg(long)]
        json: bool,
        entity: Option<String>,
        attribute: Option<String>,
        value: Option<String>,
    },
}

#[derive(Debug, Clone, Args)]
pub struct QueryCommand {
    pub expression: String,
}

#[derive(Debug, Clone, Args)]
pub struct EntityCommand {
    #[command(subcommand)]
    pub command: EntitySubcommand,
}

#[derive(Debug, Clone, Subcommand)]
pub enum EntitySubcommand {
    Get { uri: String },
}

impl Default for Command {
    fn default() -> Self {
        Self::Server(Server {
            command: Some(ServerCommand::Start(cmd::Run {})),
        })
    }
}

impl Cli {
    pub async fn run(self) -> Result<()> {
        let _ = dotenv();
        let workspace = Workspace::at(self.workspace.clone());
        let config = PoneglyphDaemonConfig::load_from(&workspace).await?;
        init_tracing(&workspace, &config)?;

        match self.command.unwrap_or_default() {
            Command::Server(server) => match server
                .command
                .unwrap_or(ServerCommand::Status { json: false })
            {
                ServerCommand::Start(cmd) => cmd.run(workspace, config).await,
                ServerCommand::Repair(cmd) => cmd.run(workspace, config).await,
                ServerCommand::Status { json } => crate::server::status(config, json).await,
                ServerCommand::Stop { json } => crate::server::stop(config, json).await,
                ServerCommand::Restart { json } => {
                    crate::server::restart(workspace, config, json).await
                }
            },
            Command::Config(command) => crate::config_cmd::run(workspace, command).await,
            Command::Schema(command) => run_schema_command(workspace, config, command).await,
            Command::Fact(command) => run_fact_command(workspace, config, command).await,
            Command::Query(command) => run_query_command(workspace, config, command).await,
            Command::Entity(command) => run_entity_command(workspace, config, command).await,
        }
    }
}

async fn run_schema_command(
    workspace: Workspace,
    config: PoneglyphDaemonConfig,
    command: SchemaCommand,
) -> Result<()> {
    let schema = match daemon_client(&config).await {
        Ok(mut client) => {
            let json = client
                .get_schema(GetSchemaRequest {})
                .await?
                .into_inner()
                .json;
            serde_json::from_str::<SchemaDefinition>(&json)?
        }
        Err(_) => {
            let poneglyph = open_runtime(workspace.clone(), config.clone()).await?;
            poneglyph.get_schema().await?
        }
    };

    match command.command {
        SchemaSubcommand::List => print_schema_list(&schema),
        SchemaSubcommand::Get { uri: None } => {
            println!("{}", serde_json::to_string_pretty(&schema)?);
            Ok(())
        }
        SchemaSubcommand::Get { uri: Some(uri) } => print_schema_entry(schema, &uri),
        SchemaSubcommand::Apply { path } => {
            let schema = read_schema_definition(&path).await?;
            let facts = schema_definition_to_facts(schema)?;
            let fact_count = facts.len();
            let tx_id = state_facts(&workspace, &config, facts).await?;
            println!("applied {fact_count} schema facts in {tx_id}");
            Ok(())
        }
    }
}

fn print_schema_list(schema: &SchemaDefinition) -> Result<()> {
    for namespace in &schema.namespaces {
        println!("namespace\t{}", namespace.uri);
    }
    for kind in &schema.kinds {
        println!("kind\t{}", kind.uri);
    }
    for field in &schema.fields {
        println!("field\t{}", field.uri);
    }
    Ok(())
}

async fn read_schema_definition(path: &std::path::Path) -> Result<SchemaDefinition> {
    let contents = tokio::fs::read_to_string(path).await?;
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("toml") => toml::from_str(&contents).map_err(Into::into),
        _ => serde_json::from_str(&contents).map_err(Into::into),
    }
}

fn schema_definition_to_facts(schema: SchemaDefinition) -> Result<Vec<Fact>> {
    let mut facts = Vec::new();

    for namespace in schema.namespaces {
        push_schema_entry_facts(
            &mut facts,
            namespace.uri,
            "schema:namespace",
            namespace.name,
            namespace.doc,
        )?;
    }

    for kind in schema.kinds {
        push_schema_entry_facts(&mut facts, kind.uri, "schema:kind", kind.name, kind.doc)?;
    }

    for field in schema.fields {
        let uri = field.uri;
        push_schema_entry_facts(
            &mut facts,
            uri.clone(),
            "schema:field",
            field.name,
            field.doc,
        )?;
        push_optional_reference_fact(&mut facts, &uri, "schema:sameAs", field.same_as)?;
        push_optional_reference_fact(&mut facts, &uri, "schema:field:domain", field.domain)?;
        push_optional_reference_fact(&mut facts, &uri, "schema:field:range", field.range)?;
        push_optional_text_fact(&mut facts, &uri, "schema:field:valueType", field.value_type)?;
        push_optional_text_fact(
            &mut facts,
            &uri,
            "schema:field:cardinality",
            field.cardinality,
        )?;
        push_optional_bool_fact(
            &mut facts,
            &uri,
            "schema:field:deprecated",
            field.deprecated,
        )?;
        push_optional_bool_fact(&mut facts, &uri, "schema:field:identity", field.identity)?;
    }

    Ok(facts)
}

fn push_schema_entry_facts(
    facts: &mut Vec<Fact>,
    uri: Uri,
    schema_type: &str,
    name: Option<String>,
    doc: Option<String>,
) -> Result<()> {
    facts.push(schema_fact(
        uri.clone(),
        "schema:type",
        Value::reference(parse_uri(schema_type)?),
    )?);
    push_optional_text_fact(facts, &uri, "schema:name", name)?;
    push_optional_text_fact(facts, &uri, "schema:doc", doc)?;
    Ok(())
}

fn push_optional_text_fact(
    facts: &mut Vec<Fact>,
    entity: &Uri,
    field: &str,
    value: Option<String>,
) -> Result<()> {
    if let Some(value) = value {
        facts.push(schema_fact(entity.clone(), field, Value::text(value))?);
    }
    Ok(())
}

fn push_optional_bool_fact(
    facts: &mut Vec<Fact>,
    entity: &Uri,
    field: &str,
    value: Option<bool>,
) -> Result<()> {
    if let Some(value) = value {
        facts.push(schema_fact(entity.clone(), field, Value::boolean(value))?);
    }
    Ok(())
}

fn push_optional_reference_fact(
    facts: &mut Vec<Fact>,
    entity: &Uri,
    field: &str,
    value: Option<Uri>,
) -> Result<()> {
    if let Some(value) = value {
        facts.push(schema_fact(entity.clone(), field, Value::reference(value))?);
    }
    Ok(())
}

fn schema_fact(entity: Uri, field: &str, value: Value) -> Result<Fact> {
    Ok(Fact::builder()
        .source(parse_uri("poneglyph:cli")?)
        .entity(entity)
        .field(parse_uri(field)?)
        .value(value)
        .build()?)
}

fn print_schema_entry(schema: SchemaDefinition, uri: &str) -> Result<()> {
    let matches = serde_json::json!({
        "namespaces": schema.namespaces.into_iter().filter(|entry| entry.uri.as_str() == uri).collect::<Vec<_>>(),
        "kinds": schema.kinds.into_iter().filter(|entry| entry.uri.as_str() == uri).collect::<Vec<_>>(),
        "fields": schema.fields.into_iter().filter(|entry| entry.uri.as_str() == uri).collect::<Vec<_>>(),
    });
    println!("{}", serde_json::to_string_pretty(&matches)?);
    Ok(())
}

async fn run_fact_command(
    workspace: Workspace,
    config: PoneglyphDaemonConfig,
    command: FactCommand,
) -> Result<()> {
    match command.command {
        FactSubcommand::State {
            entity,
            attribute,
            value,
            source,
            json,
        } => {
            let fact = Fact::builder()
                .source(parse_uri(source.as_deref().unwrap_or("poneglyph:cli"))?)
                .entity(parse_uri(&entity)?)
                .field(parse_uri(&attribute)?)
                .value(parse_cli_value(&value)?)
                .build()?;
            let outcome = state_fact(&workspace, &config, fact).await?;
            print_fact_outcome(&outcome, json)
        }
        FactSubcommand::Retract {
            fact: Some(fact_id),
            json,
            ..
        } => {
            let outcome = retract_fact_by_id(&workspace, &config, &fact_id).await?;
            print_fact_outcome(&outcome, json)
        }
        FactSubcommand::Retract {
            fact: None,
            entity: Some(entity),
            attribute: Some(attribute),
            value: Some(value),
            json,
        } => {
            let fact = Fact::builder()
                .source(parse_uri("poneglyph:cli")?)
                .entity(parse_uri(&entity)?)
                .field(parse_uri(&attribute)?)
                .value(parse_cli_value(&value)?)
                .retract()
                .build()?;
            let outcome = state_fact(&workspace, &config, fact).await?;
            print_fact_outcome(&outcome, json)
        }
        FactSubcommand::Retract { .. } => {
            anyhow::bail!("retract requires --fact or entity attribute value")
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
struct FactOutcome {
    tx_id: String,
    fact_id: String,
    fact_ids: Vec<String>,
}

fn print_fact_outcome(outcome: &FactOutcome, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(outcome)?);
    } else {
        println!("tx_id: {}", outcome.tx_id);
        if !outcome.fact_id.is_empty() {
            println!("fact_id: {}", outcome.fact_id);
        }
    }
    Ok(())
}

async fn state_fact(
    workspace: &Workspace,
    config: &PoneglyphDaemonConfig,
    fact: Fact,
) -> Result<FactOutcome> {
    match daemon_client(config).await {
        Ok(mut client) => {
            let response = client
                .state_fact(StateFactRequest {
                    fact_json: serde_json::to_string(&fact)?,
                })
                .await?
                .into_inner();
            Ok(FactOutcome {
                tx_id: response.tx_id,
                fact_id: response.fact_id,
                fact_ids: response.fact_ids,
            })
        }
        Err(_) => {
            let fact_id = fact.fact_id.to_string();
            let poneglyph = open_runtime(workspace.clone(), config.clone()).await?;
            let tx_id = poneglyph.state_facts(vec![fact]).await?.to_string();
            Ok(FactOutcome {
                tx_id,
                fact_id: fact_id.clone(),
                fact_ids: vec![fact_id],
            })
        }
    }
}

async fn state_facts(
    workspace: &Workspace,
    config: &PoneglyphDaemonConfig,
    facts: Vec<Fact>,
) -> Result<String> {
    match daemon_client(config).await {
        Ok(mut client) => Ok(client
            .state_facts(StateFactsRequest {
                fact_json: facts
                    .iter()
                    .map(serde_json::to_string)
                    .collect::<Result<Vec<_>, _>>()?,
            })
            .await?
            .into_inner()
            .tx_id),
        Err(_) => {
            let poneglyph = open_runtime(workspace.clone(), config.clone()).await?;
            Ok(poneglyph.state_facts(facts).await?.to_string())
        }
    }
}

async fn retract_fact_by_id(
    workspace: &Workspace,
    config: &PoneglyphDaemonConfig,
    fact_id: &str,
) -> Result<FactOutcome> {
    match daemon_client(config).await {
        Ok(mut client) => {
            let response = client
                .retract_fact_by_id(RetractFactByIdRequest {
                    fact_id: fact_id.to_string(),
                })
                .await?
                .into_inner();
            Ok(FactOutcome {
                tx_id: response.tx_id,
                fact_id: response.fact_id,
                fact_ids: response.fact_ids,
            })
        }
        Err(_) => {
            let fact_id = parse_uri(fact_id)?;
            let poneglyph = open_runtime(workspace.clone(), config.clone()).await?;
            let mut facts = poneglyph
                .fact_service()
                .get_facts(Filter::ById(fact_id.clone()))
                .await?;
            let fact = facts
                .recv()
                .await
                .ok_or_else(|| anyhow::anyhow!("fact `{fact_id}` not found"))??;
            let retraction = Fact::builder()
                .source(fact.source)
                .entity(fact.entity)
                .field(fact.field)
                .value(fact.value)
                .retract()
                .build()?;
            let retraction_id = retraction.fact_id.to_string();
            let tx_id = poneglyph.state_facts(vec![retraction]).await?.to_string();
            Ok(FactOutcome {
                tx_id,
                fact_id: retraction_id.clone(),
                fact_ids: vec![retraction_id],
            })
        }
    }
}

async fn run_query_command(
    workspace: Workspace,
    config: PoneglyphDaemonConfig,
    command: QueryCommand,
) -> Result<()> {
    let json = match daemon_client(&config).await {
        Ok(mut client) => {
            client
                .query(QueryRequest {
                    expression: command.expression,
                })
                .await?
                .into_inner()
                .json
        }
        Err(_) => {
            let poneglyph = open_runtime(workspace, config).await?;
            let result = poneglyph.query_str(&command.expression).await?;
            serde_json::to_string_pretty(result.substitutions())?
        }
    };
    println!("{json}");
    Ok(())
}

async fn run_entity_command(
    workspace: Workspace,
    config: PoneglyphDaemonConfig,
    command: EntityCommand,
) -> Result<()> {
    match command.command {
        EntitySubcommand::Get { uri } => {
            let json = match daemon_client(&config).await {
                Ok(mut client) => {
                    client
                        .get_entity(GetEntityRequest { uri })
                        .await?
                        .into_inner()
                        .json
                }
                Err(_) => {
                    let poneglyph = open_runtime(workspace, config).await?;
                    match poneglyph.get_entity(&parse_uri(&uri)?).await? {
                        Some(entity) => serde_json::to_string_pretty(&entity)?,
                        None => "null".to_string(),
                    }
                }
            };
            println!("{json}");
        }
    }
    Ok(())
}

fn parse_uri(value: &str) -> Result<Uri> {
    Uri::parse(value.to_string()).map_err(Into::into)
}

fn parse_cli_value(value: &str) -> Result<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(value) {
        return Ok(value);
    }
    if let Some(value) = value.strip_prefix("bool:") {
        return Ok(Value::boolean(value.parse()?));
    }
    if let Some(value) = value.strip_prefix("num:") {
        return Ok(Value::number(value));
    }
    if let Some(uri) = value.strip_prefix("ref:") {
        return Ok(Value::reference(parse_uri(uri)?));
    }
    Ok(Value::text(value))
}

fn init_tracing(workspace: &Workspace, config: &PoneglyphDaemonConfig) -> Result<()> {
    static TRACING_INIT: OnceLock<()> = OnceLock::new();
    static FILE_GUARD: OnceLock<WorkerGuard> = OnceLock::new();

    if TRACING_INIT.set(()).is_ok() {
        workspace.ensure()?;
        let log_path = config
            .logging
            .server_log_path
            .clone()
            .unwrap_or_else(|| workspace.server_log_path());
        let log_path = if log_path.is_relative() {
            workspace.root().join(log_path)
        } else {
            log_path
        };
        let log_dir = log_path.parent().unwrap_or_else(|| workspace.root());
        let file_name = log_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("server.log");
        let file_appender = tracing_appender::rolling::never(log_dir, file_name);
        let (file_writer, guard) = tracing_appender::non_blocking(file_appender);
        let _ = FILE_GUARD.set(guard);

        let filter = tracing_filter(
            config
                .poneglyph
                .log_level
                .as_deref()
                .unwrap_or(DEFAULT_LOG_LEVEL),
        );
        let stderr_layer = fmt::layer().with_target(true);
        let file_layer = fmt::layer().with_target(true).with_writer(file_writer);
        let _ = tracing_subscriber::registry()
            .with(filter)
            .with(stderr_layer)
            .with(file_layer)
            .try_init();
    }
    Ok(())
}

fn tracing_filter(level: &str) -> EnvFilter {
    EnvFilter::new(canonical_log_level(level))
        .add_directive("tantivy=off".parse().expect("valid tantivy off directive"))
        .add_directive("mio=off".parse().expect("valid mio off directive"))
        .add_directive("hyper=off".parse().expect("valid hyper off directive"))
        .add_directive("reqwest=off".parse().expect("valid reqwest off directive"))
}

fn canonical_log_level(level: &str) -> &'static str {
    match level {
        "off" => "off",
        "error" => "error",
        "warn" => "warn",
        "info" => "info",
        "debug" => "debug",
        "trace" => "trace",
        _ => "off",
    }
}

#[cfg(test)]
mod tests {
    use clap::Parser;
    use poneglyph_core::default_workspace_path;
    use tracing_subscriber::EnvFilter;

    use super::{Cli, Command, ConfigSubcommand, FactSubcommand, ServerCommand, tracing_filter};

    #[test]
    fn cli_parses_default_invocation() {
        let cli = Cli::try_parse_from(["poneglyph"]).expect("cli");

        assert_eq!(cli.workspace, default_workspace_path());
    }

    #[test]
    fn cli_parses_workspace_override() {
        let cli = Cli::try_parse_from(["poneglyph", "--workspace", "/tmp/poneglyph"]).expect("cli");

        assert_eq!(cli.workspace, std::path::Path::new("/tmp/poneglyph"));
    }

    #[test]
    fn cli_parses_server_start() {
        let cli = Cli::try_parse_from(["poneglyph", "server", "start"]).expect("cli");
        assert!(matches!(
            cli.command,
            Some(Command::Server(server)) if matches!(server.command, Some(ServerCommand::Start(_)))
        ));
    }

    #[test]
    fn cli_parses_namespaced_config_set() {
        let cli =
            Cli::try_parse_from(["poneglyph", "config", "set", "a.b.c", "value"]).expect("cli");
        assert!(matches!(
            cli.command,
            Some(Command::Config(config)) if matches!(config.command, ConfigSubcommand::Set { ref key, ref value } if key == "a.b.c" && value == "value")
        ));
    }

    #[test]
    fn cli_parses_fact_state_with_source() {
        let cli = Cli::try_parse_from([
            "poneglyph",
            "fact",
            "state",
            "pone://entity/alice",
            "name",
            "Alice",
            "--source",
            "agent://robin",
        ])
        .expect("cli");
        assert!(matches!(
            cli.command,
            Some(Command::Fact(fact)) if matches!(fact.command, FactSubcommand::State { ref source, .. } if source.as_deref() == Some("agent://robin"))
        ));
    }

    #[test]
    fn tracing_filter_uses_requested_level() {
        let filter: EnvFilter = tracing_filter("debug");
        let rendered = filter.to_string();

        assert!(rendered.contains("debug"));
        assert!(rendered.contains("tantivy=off"));
        assert!(rendered.contains("mio=off"));
        assert!(rendered.contains("hyper=off"));
        assert!(rendered.contains("reqwest=off"));
    }

    #[test]
    fn tracing_filter_defaults_to_off_for_invalid_levels() {
        let filter: EnvFilter = tracing_filter("garbage");
        let rendered = filter.to_string();

        assert!(rendered.contains("off"));
        assert!(rendered.contains("tantivy=off"));
    }

    #[test]
    fn tracing_filter_can_disable_all_logs() {
        let filter: EnvFilter = tracing_filter("off");
        let rendered = filter.to_string();

        assert!(rendered.contains("off"));
        assert!(rendered.contains("tantivy=off"));
    }

    #[test]
    fn daemon_defaults_to_info_logging_when_unset() {
        let filter: EnvFilter = tracing_filter(super::DEFAULT_LOG_LEVEL);
        let rendered = filter.to_string();

        assert!(rendered.contains("info"));
        assert!(rendered.contains("tantivy=off"));
    }

    #[test]
    fn tracing_filter_disables_tantivy_logs() {
        let filter: EnvFilter = tracing_filter("trace");
        let rendered = filter.to_string();

        assert!(rendered.contains("trace"));
        assert!(rendered.contains("tantivy=off"));
    }
}
