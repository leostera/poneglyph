use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use poneglyph::{Poneglyph, PoneglyphConfig, Workspace};
use poneglyph_mcp::PoneglyphMcpServer;
use tracing::{debug, info, instrument};

/// Long-lived daemon host for a configured [`Poneglyph`] runtime.
pub struct Daemon {
    poneglyph: Arc<Poneglyph>,
}

impl Daemon {
    pub fn builder() -> DaemonBuilder {
        DaemonBuilder::default()
    }

    #[cfg(test)]
    pub fn poneglyph(&self) -> &Poneglyph {
        &self.poneglyph
    }

    #[instrument(skip(self), fields(component = "poneglyphd"))]
    pub async fn run(self) -> Result<()> {
        info!("daemon supervising runtime and MCP server");
        let poneglyph = self.poneglyph.clone();
        let mcp = PoneglyphMcpServer::builder()
            .with_poneglyph_arc(self.poneglyph)
            .build()?;

        tokio::try_join!(
            async move { poneglyph.run().await.map_err(anyhow::Error::from) },
            async move { mcp.run().await.map_err(anyhow::Error::from) },
        )?;
        Ok(())
    }
}

#[derive(Default)]
pub struct DaemonBuilder {
    workspace: Option<Workspace>,
    config: Option<PoneglyphConfig>,
}

impl DaemonBuilder {
    pub fn at_workspace<P>(mut self, workspace: P) -> Self
    where
        P: Into<PathBuf>,
    {
        self.workspace = Some(Workspace::at(workspace.into()));
        self
    }

    pub fn with_workspace(mut self, workspace: Workspace) -> Self {
        self.workspace = Some(workspace);
        self
    }

    pub fn with_config(mut self, config: PoneglyphConfig) -> Self {
        self.config = Some(config);
        self
    }

    #[instrument(skip(self), fields(component = "poneglyphd"))]
    pub async fn build(self) -> Result<Daemon> {
        let workspace = match self.workspace {
            Some(workspace) => workspace,
            None => Workspace::new()?,
        };
        let config = match self.config {
            Some(config) => config,
            None => PoneglyphConfig::load_from(&workspace).await?,
        };
        debug!(
            workspace = %workspace.root().display(),
            log_level = ?config.log_level,
            "opening daemon runtime"
        );

        let poneglyph = Arc::new(
            Poneglyph::builder()
                .with_workspace(workspace)
                .with_config(config)
                .build()
                .await?,
        );
        info!("daemon runtime opened");
        Ok(Daemon { poneglyph })
    }
}

#[cfg(test)]
mod tests {
    use poneglyph::{PoneglyphConfig, Workspace};
    use tempfile::tempdir;

    use super::Daemon;

    #[tokio::test]
    async fn daemon_builder_uses_custom_workspace() {
        let tempdir = tempdir().expect("tempdir");

        let daemon = Daemon::builder()
            .at_workspace(tempdir.path())
            .build()
            .await
            .expect("daemon");

        assert_eq!(daemon.poneglyph().workspace().root(), tempdir.path());
        assert!(daemon.poneglyph().workspace().store_dir().exists());
    }

    #[tokio::test]
    async fn daemon_builder_accepts_workspace_and_config_overrides() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());
        let config = PoneglyphConfig::builder()
            .log_level(Some("trace".to_string()))
            .build()
            .expect("config");

        let daemon = Daemon::builder()
            .with_workspace(workspace.clone())
            .with_config(config)
            .build()
            .await
            .expect("daemon");

        assert_eq!(daemon.poneglyph().workspace().root(), workspace.root());
    }
}
