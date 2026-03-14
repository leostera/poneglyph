use std::path::PathBuf;

use anyhow::Result;
use config::{Config, File, FileFormat};
use derive_builder::Builder;
use poneglyph::{PoneglyphConfig, Workspace};
use poneglyph_ctl::PoneglyphCtlConfig;
use poneglyph_mcp::PoneglyphMcpConfig;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, Builder)]
#[builder(pattern = "owned")]
pub struct PoneglyphDaemonLoggingConfig {
    #[serde(default)]
    #[builder(default)]
    pub server_log_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, Builder)]
#[builder(pattern = "owned")]
pub struct PoneglyphDaemonConfig {
    #[serde(default)]
    #[builder(default)]
    pub poneglyph: PoneglyphConfig,
    #[serde(default)]
    #[builder(default)]
    pub ctl: PoneglyphCtlConfig,
    #[serde(default)]
    #[builder(default)]
    pub mcp: PoneglyphMcpConfig,
    #[serde(default)]
    #[builder(default)]
    pub logging: PoneglyphDaemonLoggingConfig,
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

[ctl.plex]
enabled = true
base_url = "http://127.0.0.1:32400"
token = "secret"
libraries = ["Movies", "Shows"]

[mcp]
bind_addr = "127.0.0.1:9001"

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
        assert_eq!(
            config.ctl.plex.as_ref().map(|plex| plex.enabled),
            Some(true)
        );
        assert_eq!(
            config
                .ctl
                .plex
                .as_ref()
                .and_then(|plex| plex.base_url.as_deref()),
            Some("http://127.0.0.1:32400")
        );
        assert_eq!(config.mcp.bind_addr, "127.0.0.1:9001");
        assert_eq!(
            config.logging.server_log_path.as_deref(),
            Some(std::path::Path::new("custom.log"))
        );
    }
}
