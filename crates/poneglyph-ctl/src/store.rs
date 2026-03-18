use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

use crate::{CtlError, CtlResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoogleOAuthConnection {
    pub id: i64,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub token_type: String,
    pub scopes: Vec<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveGoogleOAuthConnection {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub token_type: String,
    pub scopes: Vec<String>,
    pub expires_at: Option<DateTime<Utc>>,
}

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

    pub async fn save_google_oauth_connection(
        &self,
        connection: SaveGoogleOAuthConnection,
    ) -> CtlResult<GoogleOAuthConnection> {
        let now = Utc::now();
        let scopes = connection.scopes.join(" ");
        let expires_at = connection.expires_at.map(|value| value.to_rfc3339());
        let created_at = now.to_rfc3339();
        let updated_at = now.to_rfc3339();

        let result = sqlx::query(
            r#"
            INSERT INTO google_oauth_connections (
                access_token,
                refresh_token,
                token_type,
                scopes,
                expires_at,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&connection.access_token)
        .bind(&connection.refresh_token)
        .bind(&connection.token_type)
        .bind(&scopes)
        .bind(&expires_at)
        .bind(&created_at)
        .bind(&updated_at)
        .execute(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        self.google_oauth_connection_by_id(result.last_insert_rowid())
            .await?
            .ok_or_else(|| CtlError::StoreQuery("inserted google oauth connection missing".into()))
    }

    pub async fn latest_google_oauth_connection(&self) -> CtlResult<Option<GoogleOAuthConnection>> {
        let row = sqlx::query(
            r#"
            SELECT
                id,
                access_token,
                refresh_token,
                token_type,
                scopes,
                expires_at,
                created_at,
                updated_at
            FROM google_oauth_connections
            ORDER BY id DESC
            LIMIT 1
            "#,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        row.map(decode_google_oauth_connection).transpose()
    }

    async fn google_oauth_connection_by_id(
        &self,
        id: i64,
    ) -> CtlResult<Option<GoogleOAuthConnection>> {
        let row = sqlx::query(
            r#"
            SELECT
                id,
                access_token,
                refresh_token,
                token_type,
                scopes,
                expires_at,
                created_at,
                updated_at
            FROM google_oauth_connections
            WHERE id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        row.map(decode_google_oauth_connection).transpose()
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

    use super::{CtlStore, SaveGoogleOAuthConnection};
    use chrono::Utc;

    #[tokio::test]
    async fn ctl_store_open_creates_control_db_file() {
        let tempdir = tempdir().expect("tempdir");
        let db_path = tempdir.path().join("control.db");

        let store = CtlStore::open(&db_path).await.expect("store");

        assert!(db_path.exists());
        assert!(!store.pool().is_closed());
    }

    #[tokio::test]
    async fn ctl_store_persists_google_oauth_connections() {
        let tempdir = tempdir().expect("tempdir");
        let db_path = tempdir.path().join("control.db");
        let store = CtlStore::open(&db_path).await.expect("store");
        let expires_at = Utc::now();

        let saved = store
            .save_google_oauth_connection(SaveGoogleOAuthConnection {
                access_token: "access-token".to_string(),
                refresh_token: Some("refresh-token".to_string()),
                token_type: "Bearer".to_string(),
                scopes: vec!["scope:a".to_string(), "scope:b".to_string()],
                expires_at: Some(expires_at),
            })
            .await
            .expect("saved connection");

        let latest = store
            .latest_google_oauth_connection()
            .await
            .expect("latest")
            .expect("connection");

        assert_eq!(latest.id, saved.id);
        assert_eq!(latest.access_token, "access-token");
        assert_eq!(latest.refresh_token.as_deref(), Some("refresh-token"));
        assert_eq!(latest.token_type, "Bearer");
        assert_eq!(latest.scopes, vec!["scope:a", "scope:b"]);
        assert_eq!(latest.expires_at, Some(expires_at));
    }
}

fn decode_google_oauth_connection(
    row: sqlx::sqlite::SqliteRow,
) -> CtlResult<GoogleOAuthConnection> {
    use sqlx::Row;

    let scopes = row
        .try_get::<String, _>("scopes")
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;
    let expires_at = row
        .try_get::<Option<String>, _>("expires_at")
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?
        .map(|value| DateTime::parse_from_rfc3339(&value))
        .transpose()
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?
        .map(|value| value.with_timezone(&Utc));
    let created_at = DateTime::parse_from_rfc3339(
        &row.try_get::<String, _>("created_at")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
    )
    .map_err(|error| CtlError::StoreQuery(error.to_string()))?
    .with_timezone(&Utc);
    let updated_at = DateTime::parse_from_rfc3339(
        &row.try_get::<String, _>("updated_at")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
    )
    .map_err(|error| CtlError::StoreQuery(error.to_string()))?
    .with_timezone(&Utc);

    Ok(GoogleOAuthConnection {
        id: row
            .try_get("id")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        access_token: row
            .try_get("access_token")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        refresh_token: row
            .try_get("refresh_token")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        token_type: row
            .try_get("token_type")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        scopes: if scopes.is_empty() {
            Vec::new()
        } else {
            scopes.split(' ').map(str::to_string).collect()
        },
        expires_at,
        created_at,
        updated_at,
    })
}
