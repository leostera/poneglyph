use std::path::PathBuf;
use std::sync::OnceLock;

use anyhow::Result;
use clap::Parser;
use poneglyph::{PoneglyphConfig, Workspace, default_workspace_path};
use tracing::info;
use tracing_subscriber::EnvFilter;

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
        let config = PoneglyphConfig::load_from(&workspace).await?;
        init_tracing(config.log_level.as_deref());
        info!("dispatching daemon command");
        Daemon::builder()
            .at_workspace(self.workspace)
            .build()
            .await?
            .run()
            .await
    }
}

fn init_tracing(log_level: Option<&str>) {
    static TRACING_INIT: OnceLock<()> = OnceLock::new();

    if TRACING_INIT.set(()).is_ok() {
        let filter = EnvFilter::try_new(log_level.unwrap_or("info"))
            .unwrap_or_else(|_| EnvFilter::new("info"));
        let _ = tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_target(true)
            .try_init();
    }
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
