use std::sync::{Arc, OnceLock};

use anyhow::Result;
use poneglyph::{Poneglyph, PoneglyphConfig, Workspace};
use poneglyph_mcp::{PoneglyphMcpServer, RmcpServer};
use tracing::{debug, info, instrument};
use tracing_subscriber::EnvFilter;

use crate::cli::RunArgs;

/// Long-lived daemon host for a configured [`Poneglyph`] runtime.
pub struct Daemon {
    poneglyph: Arc<Poneglyph>,
}

impl Daemon {
    #[instrument(skip(args), fields(component = "poneglyphd"))]
    pub async fn open(args: RunArgs) -> Result<Self> {
        let workspace = match args.workspace {
            Some(workspace) => Workspace::at(workspace),
            None => Workspace::new()?,
        };
        let config = PoneglyphConfig::load_from(&workspace).await?;
        init_tracing(config.log_level.as_deref());
        debug!(workspace = %workspace.root().display(), log_level = ?config.log_level, "opening daemon runtime");

        let poneglyph = Arc::new(
            Poneglyph::builder()
                .with_workspace(workspace)
                .with_config(config)
                .build()
                .await?,
        );
        info!("daemon runtime opened");
        Ok(Self { poneglyph })
    }

    #[cfg(test)]
    pub fn poneglyph(&self) -> &Poneglyph {
        &self.poneglyph
    }

    #[instrument(skip(self), fields(component = "poneglyphd"))]
    pub async fn run(self) -> Result<()> {
        info!("daemon running; waiting for shutdown signal");
        tokio::signal::ctrl_c().await?;
        info!("shutdown signal received");
        Ok(())
    }

    #[instrument(skip(self), fields(component = "poneglyphd"))]
    pub async fn serve_mcp(self) -> Result<()> {
        info!("starting MCP stdio server");
        let server = PoneglyphMcpServer::builder()
            .with_poneglyph_arc(self.poneglyph)
            .build()?;
        RmcpServer::new(server).serve_stdio().await?;
        Ok(())
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
    use tempfile::tempdir;

    use super::Daemon;
    use crate::cli::RunArgs;

    #[tokio::test]
    async fn daemon_open_uses_custom_workspace() {
        let tempdir = tempdir().expect("tempdir");
        let args = RunArgs {
            workspace: Some(tempdir.path().to_path_buf()),
        };

        let daemon = Daemon::open(args).await.expect("daemon");

        assert_eq!(daemon.poneglyph().workspace().root(), tempdir.path());
        assert!(daemon.poneglyph().workspace().store_dir().exists());
    }
}
