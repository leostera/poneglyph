use std::path::{Path, PathBuf};

use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

use crate::{CtlError, CtlResult};

#[derive(Clone)]
pub struct CtlStore {
    pool: SqlitePool,
}

impl CtlStore {
    pub async fn open(path: impl AsRef<Path>) -> CtlResult<Self> {
        let db_path = resolve_db_path(path.as_ref());
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| CtlError::StoreIo(error.to_string()))?;
        }

        let options = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .map_err(|error| CtlError::StoreMigration(error.to_string()))?;

        sqlx::query("PRAGMA busy_timeout = 5000")
            .execute(&pool)
            .await
            .map_err(|error| CtlError::StoreMigration(error.to_string()))?;

        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .map_err(|error| CtlError::StoreMigration(error.to_string()))?;

        Ok(Self { pool })
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }
}

fn resolve_db_path(path: &Path) -> PathBuf {
    if path.extension().is_some() {
        path.to_path_buf()
    } else {
        path.join("control.db")
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::CtlStore;

    #[tokio::test]
    async fn ctl_store_open_creates_control_db_file() {
        let tempdir = tempdir().expect("tempdir");
        let db_path = tempdir.path().join("control.db");

        let store = CtlStore::open(&db_path).await.expect("store");

        assert!(db_path.exists());
        assert!(!store.pool().is_closed());
    }
}
