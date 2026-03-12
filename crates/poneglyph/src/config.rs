use serde::{Deserialize, Serialize};

use crate::{Error, PoneResult, Workspace};

/// Runtime configuration loaded from `config.toml`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Config {
    #[serde(default)]
    pub log_level: Option<String>,
}

impl Config {
    /// Loads `config.toml` from the workspace root. Missing config files return
    /// the default configuration.
    pub fn load(workspace: &Workspace) -> PoneResult<Self> {
        let config_path = workspace.config_path();
        match std::fs::read_to_string(&config_path) {
            Ok(contents) => {
                toml::from_str(&contents).map_err(|source| Error::ConfigTomlDeserialize { source })
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(source) => Err(Error::ConfigIo { source }),
        }
    }

    /// Writes `config.toml` to the workspace root, creating the workspace
    /// directory layout first.
    pub fn save(&self, workspace: &Workspace) -> PoneResult<()> {
        workspace.ensure()?;
        let contents =
            toml::to_string_pretty(self).map_err(|source| Error::ConfigTomlSerialize { source })?;
        std::fs::write(workspace.config_path(), contents)
            .map_err(|source| Error::ConfigIo { source })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::Config;
    use crate::Workspace;

    #[test]
    fn config_load_returns_default_when_missing() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());

        let config = Config::load(&workspace).expect("default config");

        assert_eq!(config, Config::default());
    }

    #[test]
    fn config_round_trips_through_workspace_file() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());
        let config = Config {
            log_level: Some("debug".to_string()),
        };

        config.save(&workspace).expect("save config");
        let loaded = Config::load(&workspace).expect("load config");

        assert_eq!(loaded, config);
    }
}
