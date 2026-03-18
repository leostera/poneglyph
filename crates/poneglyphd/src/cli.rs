use std::path::PathBuf;
use std::sync::OnceLock;

use anyhow::Result;
use clap::{Parser, Subcommand};
use dotenvy::dotenv;
use poneglyph::{Workspace, default_workspace_path};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

use crate::cmd;
use crate::config::PoneglyphDaemonConfig;

#[derive(Debug, Parser)]
#[command(name = "poneglyphd")]
#[command(about = "Run the Poneglyph daemon")]
pub struct Cli {
    /// Override the workspace root. Defaults to ~/.poneglyph.
    #[arg(long, default_value_os_t = default_workspace_path())]
    pub workspace: PathBuf,

    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Clone, Subcommand)]
pub enum Command {
    Run(cmd::Run),
    Repair(cmd::Repair),
}

impl Default for Command {
    fn default() -> Self {
        Self::Run(cmd::Run {})
    }
}

impl Cli {
    pub async fn run(self) -> Result<()> {
        let _ = dotenv();
        let workspace = Workspace::at(self.workspace.clone());
        let config = PoneglyphDaemonConfig::load_from(&workspace).await?;
        init_tracing(&workspace, &config)?;

        let cmd = self.command.unwrap_or_default();
        match cmd {
            Command::Run(cmd) => cmd.run(workspace, config).await,
            Command::Repair(cmd) => cmd.run(workspace, config).await,
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

        let filter = tracing_filter(config.poneglyph.log_level.as_deref().unwrap_or("off"));
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

    use super::{Cli, tracing_filter};

    #[test]
    fn cli_parses_default_invocation() {
        let cli = Cli::try_parse_from(["poneglyphd"]).expect("cli");

        assert_eq!(cli.workspace, default_workspace_path());
    }

    #[test]
    fn cli_parses_workspace_override() {
        let cli =
            Cli::try_parse_from(["poneglyphd", "--workspace", "/tmp/poneglyph"]).expect("cli");

        assert_eq!(cli.workspace, std::path::Path::new("/tmp/poneglyph"));
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
    fn tracing_filter_hides_all_logs_by_default() {
        let filter: EnvFilter = tracing_filter("off");
        let rendered = filter.to_string();

        assert!(rendered.contains("off"));
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
