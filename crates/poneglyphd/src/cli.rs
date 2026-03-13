use std::path::PathBuf;
use std::sync::OnceLock;

use anyhow::Result;
use clap::Parser;
use poneglyph::{Workspace, default_workspace_path};
use tracing::info;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

use crate::config::PoneglyphDaemonConfig;
use crate::daemon::Daemon;

#[derive(Debug, Parser)]
#[command(name = "poneglyphd")]
#[command(about = "Run the Poneglyph daemon")]
pub struct Cli {
    /// Override the workspace root. Defaults to ~/.poneglyph.
    #[arg(long, default_value_os_t = default_workspace_path())]
    pub workspace: PathBuf,
}

impl Cli {
    pub async fn run(self) -> Result<()> {
        let workspace = Workspace::at(self.workspace.clone());
        let config = PoneglyphDaemonConfig::load_from(&workspace).await?;
        init_tracing(&workspace, &config)?;
        info!("dispatching daemon command");
        Daemon::builder()
            .at_workspace(self.workspace)
            .with_config(config)
            .build()
            .await?
            .run()
            .await
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

        let filter = EnvFilter::try_new(config.poneglyph.log_level.as_deref().unwrap_or("info"))
            .unwrap_or_else(|_| EnvFilter::new("info"));
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

#[cfg(test)]
mod tests {
    use clap::Parser;
    use poneglyph::default_workspace_path;

    use super::Cli;

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
}
