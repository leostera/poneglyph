use std::path::PathBuf;
use std::sync::OnceLock;

use anyhow::Result;
use clap::{Args, Parser, Subcommand};
use dotenvy::dotenv;
use poneglyph_core::{Workspace, default_workspace_path};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

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
            Command::Schema(command) => crate::schema_cmd::run(workspace, config, command).await,
            Command::Fact(command) => crate::fact_cmd::run(workspace, config, command).await,
            Command::Query(command) => crate::query_cmd::run(workspace, config, command).await,
            Command::Entity(command) => crate::entity_cmd::run(workspace, config, command).await,
        }
    }
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
