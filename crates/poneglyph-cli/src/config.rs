use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::Result;
use config::{Config, File, FileFormat};
use derive_builder::Builder;
use poneglyph::{PoneglyphConfig, Workspace};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, Builder)]
#[builder(pattern = "owned")]
pub struct PoneglyphDaemonLoggingConfig {
    #[serde(default)]
    #[builder(default)]
    pub server_log_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Builder)]
#[builder(pattern = "owned")]
pub struct PoneglyphDaemonRpcConfig {
    #[serde(default = "default_rpc_bind_addr")]
    #[builder(default = "default_rpc_bind_addr()")]
    pub bind_addr: SocketAddr,
}

impl Default for PoneglyphDaemonRpcConfig {
    fn default() -> Self {
        Self {
            bind_addr: default_rpc_bind_addr(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Builder)]
#[builder(pattern = "owned")]
pub struct PoneglyphDaemonConfig {
    #[serde(default)]
    #[builder(default)]
    pub poneglyph: PoneglyphConfig,
    #[serde(default)]
    #[builder(default)]
    pub rpc: PoneglyphDaemonRpcConfig,
    #[serde(default)]
    #[builder(default)]
    pub logging: PoneglyphDaemonLoggingConfig,
}

impl Default for PoneglyphDaemonConfig {
    fn default() -> Self {
        Self {
            poneglyph: PoneglyphConfig::default(),
            rpc: PoneglyphDaemonRpcConfig::default(),
            logging: PoneglyphDaemonLoggingConfig::default(),
        }
    }
}

fn default_rpc_bind_addr() -> SocketAddr {
    "127.0.0.1:5747"
        .parse()
        .expect("valid default RPC bind addr")
}

impl PoneglyphDaemonConfig {
    #[cfg(test)]
    pub fn builder() -> PoneglyphDaemonConfigBuilder {
        PoneglyphDaemonConfigBuilder::default()
    }

    pub async fn load_from(workspace: &Workspace) -> Result<Self> {
        let config_path = workspace.config_path();
        if !tokio::fs::try_exists(&config_path).await? {
            return Ok(Self::default());
        }

        Config::builder()
            .add_source(File::new(
                config_path.to_string_lossy().as_ref(),
                FileFormat::Toml,
            ))
            .build()?
            .try_deserialize()
            .map_err(Into::into)
    }

    pub async fn save_to(&self, workspace: &Workspace) -> Result<()> {
        workspace.ensure()?;
        let contents = toml::to_string_pretty(self)?;
        tokio::fs::write(workspace.config_path(), contents).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::PoneglyphDaemonConfig;
    use poneglyph::Workspace;

    #[tokio::test]
    async fn daemon_config_loads_defaults_when_missing() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());

        let config = PoneglyphDaemonConfig::load_from(&workspace)
            .await
            .expect("default config");

        assert_eq!(config, PoneglyphDaemonConfig::default());
    }

    #[tokio::test]
    async fn daemon_config_loads_hierarchical_toml() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());
        workspace.ensure().expect("workspace");
        tokio::fs::write(
            workspace.config_path(),
            r#"
[poneglyph]
log_level = "debug"

[rpc]
bind_addr = "127.0.0.1:5748"

[logging]
server_log_path = "custom.log"
"#,
        )
        .await
        .expect("write config");

        let config = PoneglyphDaemonConfig::load_from(&workspace)
            .await
            .expect("loaded config");

        assert_eq!(config.poneglyph.log_level.as_deref(), Some("debug"));
        assert_eq!(config.rpc.bind_addr.to_string(), "127.0.0.1:5748");
        assert_eq!(
            config.logging.server_log_path.as_deref(),
            Some(std::path::Path::new("custom.log"))
        );
    }
}
