use std::sync::Arc;

use anyhow::Result;
use poneglyph::{Poneglyph, Workspace};
use poneglyph_api::PoneglyphApiServer;
use poneglyph_ctl::{
    ConnectorRuntime, CtlStore, FilesystemConnector, GcalConnector, GmailConnector, PlexConnector,
};
use tracing::{debug, info};

use crate::config::PoneglyphDaemonConfig;

/// Long-lived daemon host for a configured [`Poneglyph`] runtime.
pub struct Daemon {
    poneglyph: Arc<Poneglyph>,
    connectors: ConnectorRuntime,
    api: PoneglyphApiServer,
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
        info!("daemon supervising runtime, connectors, and api server");
        let poneglyph = self.poneglyph.clone();
        let connectors = self.connectors;
        let api = self.api;

        tokio::try_join!(
            async move { poneglyph.run().await.map_err(anyhow::Error::from) },
            async move { connectors.run().await.map_err(anyhow::Error::from) },
            async move { api.run().await.map_err(anyhow::Error::from) },
        )?;
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
            api_bind_addr = %config.api.bind_addr,
            "opening daemon runtime"
        );
        let api_bind_addr = config.api.bind_addr.clone();
        let ctl = CtlStore::open(workspace.control_db_path()).await?;

        let poneglyph = Arc::new(
            Poneglyph::builder()
                .with_workspace(workspace)
                .with_config(config.poneglyph.clone())
                .build()
                .await?,
        );
        let api = PoneglyphApiServer::builder()
            .with_poneglyph_arc(poneglyph.clone())
            .with_ctl_store(ctl.clone())
            .with_ctl_config(config.ctl.clone())
            .with_bind_addr(api_bind_addr)
            .with_api_config(config.api.clone())
            .build()?;
        let connectors = {
            ConnectorRuntime::builder()
                .with_poneglyph_arc(poneglyph.clone())
                .with_ctl_store(ctl)
                .add_filesystem_connector(FilesystemConnector::init(
                    config.ctl.filesystem.clone().unwrap_or_default(),
                )?)
                .add_gcal_connector(GcalConnector::init(
                    config.ctl.gcal.clone().unwrap_or_default(),
                )?)
                .add_gmail_connector(GmailConnector::init(
                    config.ctl.gmail.clone().unwrap_or_default(),
                )?)
                .add_plex_connector(PlexConnector::init(
                    config.ctl.plex.clone().unwrap_or_default(),
                )?)
                .build()
                .expect("connector runtime")
        };
        info!("daemon runtime opened");
        Ok(Daemon {
            poneglyph,
            connectors,
            api,
        })
    }
}

#[cfg(test)]
mod tests {
    use poneglyph::{PoneglyphConfig, Workspace};
    use poneglyph_api::PoneglyphApiConfig;
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
            .api(
                PoneglyphApiConfig::builder()
                    .bind_addr("127.0.0.1:9002".to_string())
                    .build()
                    .expect("api config"),
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
