use std::sync::Arc;

use anyhow::Result;
use poneglyph_core::{Poneglyph, Workspace};
use tokio::sync::oneshot;
use tonic::transport::Server;
use tracing::{debug, info};

use poneglyph_api::DaemonApi;
use poneglyph_api::proto::poneglyph_daemon_server::PoneglyphDaemonServer;

use crate::config::PoneglyphDaemonConfig;

/// Long-lived daemon host for a configured [`Poneglyph`] runtime.
pub struct Daemon {
    poneglyph: Arc<Poneglyph>,
    config: PoneglyphDaemonConfig,
}

impl Daemon {
    pub fn builder() -> DaemonBuilder {
        DaemonBuilder::default()
    }

    #[cfg(test)]
    pub fn poneglyph(&self) -> &Poneglyph {
        &self.poneglyph
    }

    pub async fn run(self) -> Result<()> {
        info!(
            bind_addr = %self.config.rpc.bind_addr,
            "daemon supervising core runtime and gRPC API"
        );
        let poneglyph = self.poneglyph.clone();
        let mut runtime =
            tokio::spawn(async move { poneglyph.run().await.map_err(anyhow::Error::from) });
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let api = Server::builder()
            .add_service(PoneglyphDaemonServer::new(DaemonApi::new(
                self.poneglyph,
                shutdown_tx,
            )))
            .serve_with_shutdown(self.config.rpc.bind_addr, async move {
                let _ = shutdown_rx.await;
            });

        tokio::select! {
            result = api => result.map_err(anyhow::Error::from)?,
            result = &mut runtime => result??,
        }

        runtime.abort();
        Ok(())
    }
}

#[derive(Default)]
pub struct DaemonBuilder {
    workspace: Option<Workspace>,
    config: Option<PoneglyphDaemonConfig>,
}

impl DaemonBuilder {
    #[cfg(test)]
    pub fn at_workspace<P>(mut self, workspace: P) -> Self
    where
        P: Into<std::path::PathBuf>,
    {
        self.workspace = Some(Workspace::at(workspace.into()));
        self
    }

    pub fn with_workspace(mut self, workspace: Workspace) -> Self {
        self.workspace = Some(workspace);
        self
    }

    pub fn with_config(mut self, config: PoneglyphDaemonConfig) -> Self {
        self.config = Some(config);
        self
    }

    pub async fn build(self) -> Result<Daemon> {
        let workspace = match self.workspace {
            Some(workspace) => workspace,
            None => Workspace::new()?,
        };
        let config = match self.config {
            Some(config) => config,
            None => PoneglyphDaemonConfig::load_from(&workspace).await?,
        };
        debug!(
            workspace = %workspace.root().display(),
            log_level = ?config.poneglyph.log_level,
            "opening daemon runtime"
        );

        let poneglyph = Arc::new(
            Poneglyph::builder()
                .with_workspace(workspace)
                .with_config(config.poneglyph.clone())
                .build()
                .await?,
        );
        info!("daemon runtime opened");
        Ok(Daemon { poneglyph, config })
    }
}

#[cfg(test)]
mod tests {
    use poneglyph_core::{PoneglyphConfig, Workspace};
    use tempfile::tempdir;

    use crate::config::PoneglyphDaemonConfig;

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
        let config = PoneglyphDaemonConfig::builder()
            .poneglyph(
                PoneglyphConfig::builder()
                    .log_level(Some("trace".to_string()))
                    .build()
                    .expect("poneglyph config"),
            )
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
