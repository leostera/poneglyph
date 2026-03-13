use derive_builder::Builder;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::{Error, PoneResult, Workspace};

/// Runtime configuration loaded from `config.toml`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, Builder)]
#[builder(pattern = "owned")]
pub struct PoneglyphConfig {
    #[serde(default)]
    #[builder(default)]
    pub log_level: Option<String>,
}

/// Backward-compatible alias for the top-level runtime configuration.
pub type Config = PoneglyphConfig;

/// Default root directory for a Poneglyph workspace.
pub fn default_workspace_path() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".poneglyph"))
        .unwrap_or_else(|| PathBuf::from(".poneglyph"))
}

impl PoneglyphConfig {
    pub fn builder() -> PoneglyphConfigBuilder {
        PoneglyphConfigBuilder::default()
    }

    /// Loads `config.toml` from the default workspace root.
    pub async fn load() -> PoneResult<Self> {
        let workspace = Workspace::new()?;
        Self::load_from(&workspace).await
    }

    /// Loads `config.toml` from the provided workspace root. Missing config
    /// files return the default configuration.
    pub async fn load_from(workspace: &Workspace) -> PoneResult<Self> {
        let config_path = workspace.config_path();
        match tokio::fs::read_to_string(&config_path).await {
            Ok(contents) => {
                toml::from_str(&contents).map_err(|source| Error::ConfigTomlDeserialize { source })
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(source) => Err(Error::ConfigIo { source }),
        }
    }

    /// Writes `config.toml` to the default workspace root.
    pub async fn save(&self) -> PoneResult<()> {
        let workspace = Workspace::new()?;
        self.save_to(&workspace).await
    }

    /// Writes `config.toml` to the provided workspace root, creating the
    /// workspace directory layout first.
    pub async fn save_to(&self, workspace: &Workspace) -> PoneResult<()> {
        workspace.ensure()?;
        let contents =
            toml::to_string_pretty(self).map_err(|source| Error::ConfigTomlSerialize { source })?;
        tokio::fs::write(workspace.config_path(), contents)
            .await
            .map_err(|source| Error::ConfigIo { source })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::{PoneglyphConfig, default_workspace_path};
    use crate::Workspace;

    #[tokio::test]
    async fn config_load_returns_default_when_missing() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());

        let config = PoneglyphConfig::load_from(&workspace)
            .await
            .expect("default config");

        assert_eq!(config, PoneglyphConfig::default());
    }

    #[tokio::test]
    async fn config_round_trips_through_workspace_file() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());
        let config = PoneglyphConfig::builder()
            .log_level(Some("debug".to_string()))
            .build()
            .expect("config");

        config.save_to(&workspace).await.expect("save config");
        let loaded = PoneglyphConfig::load_from(&workspace)
            .await
            .expect("load config");

        assert_eq!(loaded, config);
    }

    #[test]
    fn default_workspace_path_prefers_home_directory() {
        let path = default_workspace_path();
        assert!(path.ends_with(".poneglyph"));
    }
}
