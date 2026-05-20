use std::path::PathBuf;
use std::process::{Command as ProcessCommand, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::Result;
use clap::{Args, Parser, Subcommand};
use dotenvy::dotenv;
use poneglyph::{
    Fact, Filter, Poneglyph, SchemaDefinition, Uri, Value, Workspace, default_workspace_path,
};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

use crate::api::proto::poneglyph_daemon_client::PoneglyphDaemonClient;
use crate::api::proto::{
    GetEntityRequest, GetSchemaRequest, QueryRequest, RetractFactByIdRequest, ShutdownRequest,
    StateFactRequest, StateFactsRequest, StatusRequest,
};
use crate::cmd;
use crate::config::PoneglyphDaemonConfig;

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
    Status,
    /// Stop the daemon.
    Stop,
    /// Restart the daemon.
    Restart,
}

#[derive(Debug, Clone, Args)]
pub struct ConfigCommand {
    #[command(subcommand)]
    pub command: ConfigSubcommand,
}

#[derive(Debug, Clone, Subcommand)]
pub enum ConfigSubcommand {
    List,
    Get { key: String },
    Set { key: String, value: String },
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
    },
    Retract {
        #[arg(long)]
        fact: Option<String>,
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
            Command::Server(server) => match server.command.unwrap_or(ServerCommand::Status) {
                ServerCommand::Start(cmd) => cmd.run(workspace, config).await,
                ServerCommand::Repair(cmd) => cmd.run(workspace, config).await,
                ServerCommand::Status => run_server_status(config).await,
                ServerCommand::Stop => run_server_stop(config).await,
                ServerCommand::Restart => run_server_restart(workspace, config).await,
            },
            Command::Config(command) => run_config_command(workspace, command).await,
            Command::Schema(command) => run_schema_command(workspace, config, command).await,
            Command::Fact(command) => run_fact_command(workspace, config, command).await,
            Command::Query(command) => run_query_command(workspace, config, command).await,
            Command::Entity(command) => run_entity_command(workspace, config, command).await,
        }
    }
}

async fn daemon_client(
    config: &PoneglyphDaemonConfig,
) -> Result<PoneglyphDaemonClient<tonic::transport::Channel>, tonic::transport::Error> {
    PoneglyphDaemonClient::connect(format!("http://{}", config.rpc.bind_addr)).await
}

async fn run_server_status(config: PoneglyphDaemonConfig) -> Result<()> {
    match daemon_client(&config).await {
        Ok(mut client) => {
            let status = client.status(StatusRequest {}).await?.into_inner();
            println!("status: {}", status.status);
            println!("workspace: {}", status.workspace);
            println!("uptime_seconds: {}", status.uptime_seconds);
            Ok(())
        }
        Err(error) => {
            println!("status: offline");
            println!("error: {error}");
            Ok(())
        }
    }
}

async fn run_server_stop(config: PoneglyphDaemonConfig) -> Result<()> {
    let mut client = daemon_client(&config).await?;
    let response = client.shutdown(ShutdownRequest {}).await?.into_inner();
    println!("status: {}", response.status);
    Ok(())
}

async fn run_server_restart(workspace: Workspace, config: PoneglyphDaemonConfig) -> Result<()> {
    if daemon_client(&config).await.is_ok() {
        run_server_stop(config.clone()).await?;
        wait_until_offline(&config).await;
    }

    let current_exe = std::env::current_exe()?;
    ProcessCommand::new(current_exe)
        .arg("--workspace")
        .arg(workspace.root())
        .arg("server")
        .arg("start")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;

    wait_until_running(&config).await?;
    println!("status: restarted");
    Ok(())
}

async fn wait_until_offline(config: &PoneglyphDaemonConfig) {
    for _ in 0..40 {
        if daemon_client(config).await.is_err() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn wait_until_running(config: &PoneglyphDaemonConfig) -> Result<()> {
    let mut last_error = None;
    for _ in 0..80 {
        match daemon_client(config).await {
            Ok(mut client) => {
                if client.status(StatusRequest {}).await.is_ok() {
                    return Ok(());
                }
                last_error = Some("status RPC failed".to_string());
            }
            Err(error) => last_error = Some(error.to_string()),
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    anyhow::bail!(
        "daemon did not become ready: {}",
        last_error.unwrap_or_else(|| "unknown error".to_string())
    )
}

async fn open_runtime(workspace: Workspace, config: PoneglyphDaemonConfig) -> Result<Poneglyph> {
    Poneglyph::builder()
        .with_workspace(workspace)
        .with_config(config.poneglyph)
        .build()
        .await
        .map_err(Into::into)
}

async fn run_config_command(workspace: Workspace, command: ConfigCommand) -> Result<()> {
    match command.command {
        ConfigSubcommand::List => {
            let config = PoneglyphDaemonConfig::load_from(&workspace).await?;
            println!("{}", toml::to_string_pretty(&config)?);
            Ok(())
        }
        ConfigSubcommand::Get { key } => {
            let config = PoneglyphDaemonConfig::load_from(&workspace).await?;
            match key.as_str() {
                "log_level" | "poneglyph.log_level" => {
                    if let Some(value) = config.poneglyph.log_level {
                        println!("{value}");
                    }
                    Ok(())
                }
                "rpc.bind_addr" => {
                    println!("{}", config.rpc.bind_addr);
                    Ok(())
                }
                "logging.server_log_path" => {
                    if let Some(value) = config.logging.server_log_path {
                        println!("{}", value.display());
                    }
                    Ok(())
                }
                _ => anyhow::bail!("unknown config key `{key}`"),
            }
        }
        ConfigSubcommand::Set { key, value } => {
            let mut config = PoneglyphDaemonConfig::load_from(&workspace).await?;
            match key.as_str() {
                "log_level" | "poneglyph.log_level" => {
                    config.poneglyph.log_level = if value.is_empty() || value == "null" {
                        None
                    } else {
                        Some(value)
                    };
                    config.save_to(&workspace).await?;
                    println!("{}", toml::to_string_pretty(&config)?);
                    Ok(())
                }
                "rpc.bind_addr" => {
                    config.rpc.bind_addr = value.parse()?;
                    config.save_to(&workspace).await?;
                    println!("{}", toml::to_string_pretty(&config)?);
                    Ok(())
                }
                "logging.server_log_path" => {
                    config.logging.server_log_path = if value.is_empty() || value == "null" {
                        None
                    } else {
                        Some(value.into())
                    };
                    config.save_to(&workspace).await?;
                    println!("{}", toml::to_string_pretty(&config)?);
                    Ok(())
                }
                _ => anyhow::bail!("unknown config key `{key}`"),
            }
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
    let fact = match command.command {
        FactSubcommand::State {
            entity,
            attribute,
            value,
            source,
        } => Fact::builder()
            .source(parse_uri(source.as_deref().unwrap_or("poneglyph:cli"))?)
            .entity(parse_uri(&entity)?)
            .field(parse_uri(&attribute)?)
            .value(parse_cli_value(&value)?)
            .build()?,
        FactSubcommand::Retract {
            fact: Some(fact_id),
            ..
        } => {
            let tx_id = retract_fact_by_id(&workspace, &config, &fact_id).await?;
            println!("{tx_id}");
            return Ok(());
        }
        FactSubcommand::Retract {
            fact: None,
            entity: Some(entity),
            attribute: Some(attribute),
            value: Some(value),
        } => Fact::builder()
            .source(parse_uri("poneglyph:cli")?)
            .entity(parse_uri(&entity)?)
            .field(parse_uri(&attribute)?)
            .value(parse_cli_value(&value)?)
            .retract()
            .build()?,
        FactSubcommand::Retract { .. } => {
            anyhow::bail!("retract requires --fact or entity attribute value")
        }
    };

    let tx_id = state_fact(&workspace, &config, fact).await?;
    println!("{tx_id}");
    Ok(())
}

async fn state_fact(
    workspace: &Workspace,
    config: &PoneglyphDaemonConfig,
    fact: Fact,
) -> Result<String> {
    match daemon_client(config).await {
        Ok(mut client) => Ok(client
            .state_fact(StateFactRequest {
                fact_json: serde_json::to_string(&fact)?,
            })
            .await?
            .into_inner()
            .tx_id),
        Err(_) => {
            let poneglyph = open_runtime(workspace.clone(), config.clone()).await?;
            Ok(poneglyph.state_facts(vec![fact]).await?.to_string())
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
) -> Result<String> {
    match daemon_client(config).await {
        Ok(mut client) => Ok(client
            .retract_fact_by_id(RetractFactByIdRequest {
                fact_id: fact_id.to_string(),
            })
            .await?
            .into_inner()
            .tx_id),
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
            Ok(poneglyph.state_facts(vec![retraction]).await?.to_string())
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
    use poneglyph::default_workspace_path;
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
