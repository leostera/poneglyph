use std::path::PathBuf;

use anyhow::Result;
use clap::{Args, Parser, Subcommand};
use dotenvy::dotenv;
use poneglyph_core::{Workspace, default_workspace_path};

use crate::cmd;
use crate::config::PoneglyphDaemonConfig;

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
        /// Print machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
    Set {
        key: String,
        value: String,
        /// Print machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Clone, Args)]
pub struct SchemaCommand {
    #[command(subcommand)]
    pub command: SchemaSubcommand,
}

#[derive(Debug, Clone, Subcommand)]
pub enum SchemaSubcommand {
    List {
        /// Print machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
    Get {
        uri: Option<String>,
        /// Print machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
    Apply {
        path: PathBuf,
        /// Print machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
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
    /// Print machine-readable JSON.
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Clone, Args)]
pub struct EntityCommand {
    #[command(subcommand)]
    pub command: EntitySubcommand,
}

#[derive(Debug, Clone, Subcommand)]
pub enum EntitySubcommand {
    List {
        /// Maximum number of entities to print.
        #[arg(long, default_value_t = 50)]
        limit: usize,
        /// Number of entities to skip.
        #[arg(long, default_value_t = 0)]
        offset: usize,
        /// Print machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
    Get {
        uri: String,
        /// Print machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
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
        crate::tracing::init(&workspace, &config)?;

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

#[cfg(test)]
mod tests {
    use clap::{CommandFactory, Parser};
    use poneglyph_core::default_workspace_path;

    use super::{Cli, Command, ConfigSubcommand, EntitySubcommand, FactSubcommand, ServerCommand};

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
    fn server_help_mentions_json_output_flags() {
        let mut command = Cli::command();
        let server = command.find_subcommand_mut("server").expect("server help");

        for subcommand in ["repair", "status", "stop", "restart"] {
            let help = server
                .find_subcommand_mut(subcommand)
                .expect("server subcommand help")
                .render_long_help()
                .to_string();
            assert!(
                help.contains("--json"),
                "missing --json in server {subcommand} help:\n{help}"
            );
        }
    }

    #[test]
    fn top_level_help_lists_public_namespaces() {
        let help = Cli::command().render_long_help().to_string();

        for namespace in ["server", "config", "schema", "fact", "query", "entity"] {
            assert!(
                help.contains(namespace),
                "missing {namespace} in help:\n{help}"
            );
        }
    }

    #[test]
    fn config_help_mentions_json_output_flags() {
        let mut command = Cli::command();
        let config = command.find_subcommand_mut("config").expect("config help");

        for subcommand in ["list", "get", "set"] {
            let help = config
                .find_subcommand_mut(subcommand)
                .expect("config subcommand help")
                .render_long_help()
                .to_string();
            assert!(
                help.contains("--json"),
                "missing --json in config {subcommand} help:\n{help}"
            );
        }
    }

    #[test]
    fn schema_help_mentions_json_output_flags() {
        let mut command = Cli::command();
        let schema = command.find_subcommand_mut("schema").expect("schema help");

        for subcommand in ["list", "get", "apply"] {
            let help = schema
                .find_subcommand_mut(subcommand)
                .expect("schema subcommand help")
                .render_long_help()
                .to_string();
            assert!(
                help.contains("--json"),
                "missing --json in schema {subcommand} help:\n{help}"
            );
        }
    }

    #[test]
    fn query_and_entity_help_mentions_json_output_flags() {
        let mut command = Cli::command();
        let query_help = command
            .find_subcommand_mut("query")
            .expect("query help")
            .render_long_help()
            .to_string();
        assert!(
            query_help.contains("--json"),
            "missing --json in query help:\n{query_help}"
        );

        let mut command = Cli::command();
        let entity = command.find_subcommand_mut("entity").expect("entity help");
        for subcommand in ["get", "list"] {
            let help = entity
                .find_subcommand_mut(subcommand)
                .expect("entity subcommand help")
                .render_long_help()
                .to_string();
            assert!(
                help.contains("--json"),
                "missing --json in entity {subcommand} help:\n{help}"
            );
        }
    }

    #[test]
    fn cli_parses_namespaced_config_set() {
        let cli =
            Cli::try_parse_from(["poneglyph", "config", "set", "a.b.c", "value"]).expect("cli");
        assert!(matches!(
            cli.command,
            Some(Command::Config(config)) if matches!(config.command, ConfigSubcommand::Set { ref key, ref value, .. } if key == "a.b.c" && value == "value")
        ));
    }

    #[test]
    fn cli_parses_query_json_flag() {
        let cli = Cli::try_parse_from([
            "poneglyph",
            "query",
            "spotify:displayName(Album, Name)",
            "--json",
        ])
        .expect("cli");
        assert!(matches!(
            cli.command,
            Some(Command::Query(query)) if query.json
        ));
    }

    #[test]
    fn cli_parses_entity_get_json_flag() {
        let cli = Cli::try_parse_from([
            "poneglyph",
            "entity",
            "get",
            "spotify:album:signals",
            "--json",
        ])
        .expect("cli");
        assert!(matches!(
            cli.command,
            Some(Command::Entity(entity)) if matches!(entity.command, EntitySubcommand::Get { json: true, .. })
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
}
