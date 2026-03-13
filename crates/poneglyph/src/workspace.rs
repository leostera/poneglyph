use std::env;
use std::path::{Path, PathBuf};

use crate::{Error, PoneResult};

/// Filesystem layout for a Poneglyph workspace.
///
/// By default this resolves to `~/.poneglyph`, but tests and embedded callers
/// can point it at any other root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    root: PathBuf,
}

impl Workspace {
    /// Creates a workspace rooted at `~/.poneglyph`.
    pub fn new() -> PoneResult<Self> {
        Ok(Self::at(Self::default_root()?))
    }

    /// Creates a workspace rooted at a custom path.
    pub fn at(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Returns the workspace root directory.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Returns the `config.toml` path.
    pub fn config_path(&self) -> PathBuf {
        self.root.join("config.toml")
    }

    /// Returns the daemon log file path.
    pub fn server_log_path(&self) -> PathBuf {
        self.root.join("server.log")
    }

    /// Returns the shared data store directory.
    pub fn store_dir(&self) -> PathBuf {
        self.root.join("store")
    }

    /// Returns the facts sqlite database path.
    pub fn facts_db_path(&self) -> PathBuf {
        self.store_dir().join("facts.db")
    }

    /// Returns the entities sqlite database path.
    pub fn entities_db_path(&self) -> PathBuf {
        self.store_dir().join("entities.db")
    }

    /// Returns the search index path.
    pub fn search_db_path(&self) -> PathBuf {
        self.store_dir().join("search.db")
    }

    /// Ensures the workspace root and common directories exist.
    pub fn ensure(&self) -> PoneResult<()> {
        std::fs::create_dir_all(&self.root).map_err(|source| Error::WorkspaceIo { source })?;
        std::fs::create_dir_all(self.store_dir())
            .map_err(|source| Error::WorkspaceIo { source })?;
        Ok(())
    }

    fn default_root() -> PoneResult<PathBuf> {
        let home = env::var_os("HOME").ok_or(Error::HomeDirectoryUnavailable)?;
        Ok(PathBuf::from(home).join(".poneglyph"))
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::Workspace;

    #[test]
    fn workspace_uses_custom_root() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());

        assert_eq!(workspace.root(), tempdir.path());
        assert_eq!(workspace.config_path(), tempdir.path().join("config.toml"));
        assert_eq!(
            workspace.server_log_path(),
            tempdir.path().join("server.log")
        );
        assert_eq!(workspace.store_dir(), tempdir.path().join("store"));
        assert_eq!(
            workspace.facts_db_path(),
            tempdir.path().join("store").join("facts.db")
        );
        assert_eq!(
            workspace.entities_db_path(),
            tempdir.path().join("store").join("entities.db")
        );
        assert_eq!(
            workspace.search_db_path(),
            tempdir.path().join("store").join("search.db")
        );
    }

    #[test]
    fn workspace_ensure_creates_common_directories() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path().join("nested"));

        workspace.ensure().expect("workspace directories");

        assert!(workspace.root().exists());
        assert!(workspace.store_dir().exists());
    }
}
