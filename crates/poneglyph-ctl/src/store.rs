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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoogleCalendarResource {
    pub id: i64,
    pub connection_id: i64,
    pub calendar_id: String,
    pub summary: String,
    pub description: Option<String>,
    pub time_zone: Option<String>,
    pub primary: bool,
    pub selected: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoogleCalendarSyncState {
    pub id: i64,
    pub connection_id: i64,
    pub calendar_id: String,
    pub next_sync_token: Option<String>,
    pub last_synced_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GmailSyncState {
    pub id: i64,
    pub connection_id: i64,
    pub last_history_id: Option<String>,
    pub last_synced_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlexLibrarySyncState {
    pub id: i64,
    pub library_key: String,
    pub content_fingerprint: Option<String>,
    pub last_synced_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlexConnection {
    pub id: i64,
    pub name: String,
    pub machine_identifier: Option<String>,
    pub base_url: String,
    pub token: String,
    pub libraries: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavePlexConnection {
    pub name: String,
    pub machine_identifier: String,
    pub base_url: String,
    pub token: String,
    pub libraries: Vec<String>,
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

    pub async fn list_google_oauth_connections(&self) -> CtlResult<Vec<GoogleOAuthConnection>> {
        let rows = sqlx::query(
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
            "#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        rows.into_iter()
            .map(decode_google_oauth_connection)
            .collect()
    }

    pub async fn google_oauth_connection_by_id(
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

    pub async fn delete_google_oauth_connection(&self, id: i64) -> CtlResult<bool> {
        let result = sqlx::query(
            r#"
            DELETE FROM google_oauth_connections
            WHERE id = ?
            "#,
        )
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        Ok(result.rows_affected() > 0)
    }

    pub async fn save_google_calendar_resources(
        &self,
        connection_id: i64,
        calendars: Vec<crate::connectors::gcal::GoogleCalendarResource>,
    ) -> CtlResult<()> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?;
        let now = Utc::now().to_rfc3339();

        for calendar in calendars {
            sqlx::query(
                r#"
                INSERT INTO google_calendar_resources (
                    connection_id,
                    calendar_id,
                    summary,
                    description,
                    time_zone,
                    primary_calendar,
                    created_at,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(connection_id, calendar_id) DO UPDATE SET
                    summary = excluded.summary,
                    description = excluded.description,
                    time_zone = excluded.time_zone,
                    primary_calendar = excluded.primary_calendar,
                    updated_at = excluded.updated_at
                "#,
            )
            .bind(connection_id)
            .bind(calendar.calendar_id)
            .bind(calendar.summary)
            .bind(calendar.description)
            .bind(calendar.time_zone)
            .bind(calendar.primary)
            .bind(&now)
            .bind(&now)
            .execute(&mut *tx)
            .await
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?;
        }

        tx.commit()
            .await
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?;
        Ok(())
    }

    pub async fn list_google_calendar_resources(
        &self,
        connection_id: i64,
    ) -> CtlResult<Vec<GoogleCalendarResource>> {
        let rows = sqlx::query(
            r#"
            SELECT
                id,
                connection_id,
                calendar_id,
                summary,
                description,
                time_zone,
                primary_calendar,
                selected,
                created_at,
                updated_at
            FROM google_calendar_resources
            WHERE connection_id = ?
            ORDER BY primary_calendar DESC, summary ASC, calendar_id ASC
            "#,
        )
        .bind(connection_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        rows.into_iter()
            .map(decode_google_calendar_resource)
            .collect()
    }

    pub async fn set_google_calendar_selection(
        &self,
        connection_id: i64,
        calendar_ids: &[String],
    ) -> CtlResult<Vec<GoogleCalendarResource>> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?;
        sqlx::query(
            r#"
            UPDATE google_calendar_resources
            SET selected = 0,
                updated_at = ?
            WHERE connection_id = ?
            "#,
        )
        .bind(Utc::now().to_rfc3339())
        .bind(connection_id)
        .execute(&mut *tx)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        for calendar_id in calendar_ids {
            sqlx::query(
                r#"
                UPDATE google_calendar_resources
                SET selected = 1,
                    updated_at = ?
                WHERE connection_id = ? AND calendar_id = ?
                "#,
            )
            .bind(Utc::now().to_rfc3339())
            .bind(connection_id)
            .bind(calendar_id)
            .execute(&mut *tx)
            .await
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?;
        }

        tx.commit()
            .await
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        self.list_google_calendar_resources(connection_id).await
    }

    pub async fn google_calendar_sync_state(
        &self,
        connection_id: i64,
        calendar_id: &str,
    ) -> CtlResult<Option<GoogleCalendarSyncState>> {
        let row = sqlx::query(
            r#"
            SELECT
                id,
                connection_id,
                calendar_id,
                next_sync_token,
                last_synced_at,
                last_error,
                created_at,
                updated_at
            FROM google_calendar_sync_state
            WHERE connection_id = ? AND calendar_id = ?
            "#,
        )
        .bind(connection_id)
        .bind(calendar_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        row.map(decode_google_calendar_sync_state).transpose()
    }

    pub async fn save_google_calendar_sync_success(
        &self,
        connection_id: i64,
        calendar_id: &str,
        next_sync_token: Option<&str>,
    ) -> CtlResult<GoogleCalendarSyncState> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO google_calendar_sync_state (
                connection_id,
                calendar_id,
                next_sync_token,
                last_synced_at,
                last_error,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, NULL, ?, ?)
            ON CONFLICT(connection_id, calendar_id) DO UPDATE SET
                next_sync_token = excluded.next_sync_token,
                last_synced_at = excluded.last_synced_at,
                last_error = NULL,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(connection_id)
        .bind(calendar_id)
        .bind(next_sync_token)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        self.google_calendar_sync_state(connection_id, calendar_id)
            .await?
            .ok_or_else(|| CtlError::StoreQuery("saved google calendar sync state missing".into()))
    }

    pub async fn save_google_calendar_sync_failure(
        &self,
        connection_id: i64,
        calendar_id: &str,
        error_message: &str,
    ) -> CtlResult<GoogleCalendarSyncState> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO google_calendar_sync_state (
                connection_id,
                calendar_id,
                next_sync_token,
                last_synced_at,
                last_error,
                created_at,
                updated_at
            ) VALUES (?, ?, NULL, NULL, ?, ?, ?)
            ON CONFLICT(connection_id, calendar_id) DO UPDATE SET
                last_error = excluded.last_error,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(connection_id)
        .bind(calendar_id)
        .bind(error_message)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        self.google_calendar_sync_state(connection_id, calendar_id)
            .await?
            .ok_or_else(|| {
                CtlError::StoreQuery("saved google calendar sync failure missing".into())
            })
    }

    pub async fn gmail_sync_state(&self, connection_id: i64) -> CtlResult<Option<GmailSyncState>> {
        let row = sqlx::query(
            r#"
            SELECT
                id,
                connection_id,
                last_history_id,
                last_synced_at,
                last_error,
                created_at,
                updated_at
            FROM gmail_sync_state
            WHERE connection_id = ?
            "#,
        )
        .bind(connection_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        row.map(decode_gmail_sync_state).transpose()
    }

    pub async fn save_gmail_sync_success(
        &self,
        connection_id: i64,
        last_history_id: Option<&str>,
    ) -> CtlResult<GmailSyncState> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO gmail_sync_state (
                connection_id,
                last_history_id,
                last_synced_at,
                last_error,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, NULL, ?, ?)
            ON CONFLICT(connection_id) DO UPDATE SET
                last_history_id = excluded.last_history_id,
                last_synced_at = excluded.last_synced_at,
                last_error = NULL,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(connection_id)
        .bind(last_history_id)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        self.gmail_sync_state(connection_id).await?.ok_or_else(|| {
            CtlError::StoreQuery("saved gmail sync state missing after success".into())
        })
    }

    pub async fn save_gmail_sync_failure(
        &self,
        connection_id: i64,
        error_message: &str,
    ) -> CtlResult<GmailSyncState> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO gmail_sync_state (
                connection_id,
                last_history_id,
                last_synced_at,
                last_error,
                created_at,
                updated_at
            ) VALUES (?, NULL, NULL, ?, ?, ?)
            ON CONFLICT(connection_id) DO UPDATE SET
                last_error = excluded.last_error,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(connection_id)
        .bind(error_message)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        self.gmail_sync_state(connection_id).await?.ok_or_else(|| {
            CtlError::StoreQuery("saved gmail sync state missing after failure".into())
        })
    }

    pub async fn plex_library_sync_state(
        &self,
        library_key: &str,
    ) -> CtlResult<Option<PlexLibrarySyncState>> {
        let row = sqlx::query(
            r#"
            SELECT
                id,
                library_key,
                content_fingerprint,
                last_synced_at,
                last_error,
                created_at,
                updated_at
            FROM plex_library_sync_state
            WHERE library_key = ?
            "#,
        )
        .bind(library_key)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        row.map(decode_plex_library_sync_state).transpose()
    }

    pub async fn save_plex_library_sync_success(
        &self,
        library_key: &str,
        content_fingerprint: &str,
    ) -> CtlResult<PlexLibrarySyncState> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO plex_library_sync_state (
                library_key,
                content_fingerprint,
                last_synced_at,
                last_error,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, NULL, ?, ?)
            ON CONFLICT(library_key) DO UPDATE SET
                content_fingerprint = excluded.content_fingerprint,
                last_synced_at = excluded.last_synced_at,
                last_error = NULL,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(library_key)
        .bind(content_fingerprint)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        self.plex_library_sync_state(library_key)
            .await?
            .ok_or_else(|| CtlError::StoreQuery("saved plex library sync state missing".into()))
    }

    pub async fn save_plex_library_sync_failure(
        &self,
        library_key: &str,
        error_message: &str,
    ) -> CtlResult<PlexLibrarySyncState> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO plex_library_sync_state (
                library_key,
                content_fingerprint,
                last_synced_at,
                last_error,
                created_at,
                updated_at
            ) VALUES (?, NULL, NULL, ?, ?, ?)
            ON CONFLICT(library_key) DO UPDATE SET
                last_error = excluded.last_error,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(library_key)
        .bind(error_message)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        self.plex_library_sync_state(library_key)
            .await?
            .ok_or_else(|| CtlError::StoreQuery("saved plex library sync failure missing".into()))
    }

    pub async fn save_plex_connection(
        &self,
        connection: SavePlexConnection,
    ) -> CtlResult<PlexConnection> {
        if connection.name.trim().is_empty() {
            return Err(CtlError::StoreQuery(
                "plex connection name is required".to_string(),
            ));
        }
        if connection.machine_identifier.trim().is_empty() {
            return Err(CtlError::StoreQuery(
                "plex connection machine identifier is required".to_string(),
            ));
        }
        let now = Utc::now().to_rfc3339();
        let machine_identifier = connection.machine_identifier.clone();
        let libraries = connection.libraries.join("\n");

        sqlx::query(
            r#"
            INSERT INTO plex_connections (
                name,
                machine_identifier,
                base_url,
                token,
                libraries,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(machine_identifier) DO UPDATE SET
                name = excluded.name,
                base_url = excluded.base_url,
                token = excluded.token,
                libraries = excluded.libraries,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(connection.name)
        .bind(connection.machine_identifier)
        .bind(connection.base_url)
        .bind(connection.token)
        .bind(libraries)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        self.plex_connection_by_machine_identifier(machine_identifier.as_str())
            .await?
            .ok_or_else(|| CtlError::StoreQuery("saved plex connection missing".into()))
    }

    pub async fn list_plex_connections(&self) -> CtlResult<Vec<PlexConnection>> {
        let rows = sqlx::query(
            r#"
            SELECT
                id,
                name,
                machine_identifier,
                base_url,
                token,
                libraries,
                created_at,
                updated_at
            FROM plex_connections
            ORDER BY id DESC
            "#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        rows.into_iter().map(decode_plex_connection).collect()
    }

    pub async fn plex_connection_by_id(&self, id: i64) -> CtlResult<Option<PlexConnection>> {
        let row = sqlx::query(
            r#"
            SELECT
                id,
                name,
                machine_identifier,
                base_url,
                token,
                libraries,
                created_at,
                updated_at
            FROM plex_connections
            WHERE id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        row.map(decode_plex_connection).transpose()
    }

    pub async fn plex_connection_by_machine_identifier(
        &self,
        machine_identifier: &str,
    ) -> CtlResult<Option<PlexConnection>> {
        let row = sqlx::query(
            r#"
            SELECT
                id,
                name,
                machine_identifier,
                base_url,
                token,
                libraries,
                created_at,
                updated_at
            FROM plex_connections
            WHERE machine_identifier = ?
            "#,
        )
        .bind(machine_identifier)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        row.map(decode_plex_connection).transpose()
    }

    pub async fn delete_plex_connection(&self, id: i64) -> CtlResult<bool> {
        let result = sqlx::query(
            r#"
            DELETE FROM plex_connections
            WHERE id = ?
            "#,
        )
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        Ok(result.rows_affected() > 0)
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

    use super::{CtlStore, SaveGoogleOAuthConnection, SavePlexConnection};
    use crate::connectors::gcal::GoogleCalendarResource as DiscoveredGoogleCalendarResource;
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
        let connections = store
            .list_google_oauth_connections()
            .await
            .expect("connections");

        assert_eq!(latest.id, saved.id);
        assert_eq!(latest.access_token, "access-token");
        assert_eq!(latest.refresh_token.as_deref(), Some("refresh-token"));
        assert_eq!(latest.token_type, "Bearer");
        assert_eq!(latest.scopes, vec!["scope:a", "scope:b"]);
        assert_eq!(latest.expires_at, Some(expires_at));
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0].id, saved.id);
    }

    #[tokio::test]
    async fn ctl_store_tracks_google_calendar_resources_and_selection() {
        let tempdir = tempdir().expect("tempdir");
        let db_path = tempdir.path().join("control.db");
        let store = CtlStore::open(&db_path).await.expect("store");
        let connection = store
            .save_google_oauth_connection(SaveGoogleOAuthConnection {
                access_token: "access-token".to_string(),
                refresh_token: Some("refresh-token".to_string()),
                token_type: "Bearer".to_string(),
                scopes: vec!["scope:a".to_string()],
                expires_at: None,
            })
            .await
            .expect("saved connection");

        store
            .save_google_calendar_resources(
                connection.id,
                vec![
                    DiscoveredGoogleCalendarResource {
                        calendar_id: "primary".to_string(),
                        summary: "Primary".to_string(),
                        description: Some("Main".to_string()),
                        time_zone: Some("Europe/Prague".to_string()),
                        primary: true,
                        selected: false,
                    },
                    DiscoveredGoogleCalendarResource {
                        calendar_id: "work".to_string(),
                        summary: "Work".to_string(),
                        description: None,
                        time_zone: Some("Europe/Prague".to_string()),
                        primary: false,
                        selected: false,
                    },
                ],
            )
            .await
            .expect("save calendars");

        let all = store
            .list_google_calendar_resources(connection.id)
            .await
            .expect("list calendars");
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].calendar_id, "primary");
        assert!(!all[0].selected);

        let selected = store
            .set_google_calendar_selection(connection.id, &["work".to_string()])
            .await
            .expect("select calendars");
        assert_eq!(selected.len(), 2);
        assert!(
            selected
                .iter()
                .any(|calendar| calendar.calendar_id == "work" && calendar.selected)
        );
        assert!(
            selected
                .iter()
                .any(|calendar| calendar.calendar_id == "primary" && !calendar.selected)
        );
    }

    #[tokio::test]
    async fn ctl_store_tracks_google_calendar_sync_state() {
        let tempdir = tempdir().expect("tempdir");
        let db_path = tempdir.path().join("control.db");
        let store = CtlStore::open(&db_path).await.expect("store");
        let connection = store
            .save_google_oauth_connection(SaveGoogleOAuthConnection {
                access_token: "access-token".to_string(),
                refresh_token: Some("refresh-token".to_string()),
                token_type: "Bearer".to_string(),
                scopes: vec!["scope:a".to_string()],
                expires_at: None,
            })
            .await
            .expect("saved connection");

        let success = store
            .save_google_calendar_sync_success(connection.id, "primary", Some("next-sync-token"))
            .await
            .expect("saved success");

        assert_eq!(success.next_sync_token.as_deref(), Some("next-sync-token"));
        assert!(success.last_synced_at.is_some());
        assert_eq!(success.last_error, None);

        let failure = store
            .save_google_calendar_sync_failure(connection.id, "primary", "boom")
            .await
            .expect("saved failure");

        assert_eq!(failure.next_sync_token.as_deref(), Some("next-sync-token"));
        assert_eq!(failure.last_error.as_deref(), Some("boom"));
    }

    #[tokio::test]
    async fn ctl_store_tracks_gmail_sync_state() {
        let tempdir = tempdir().expect("tempdir");
        let db_path = tempdir.path().join("control.db");
        let store = CtlStore::open(&db_path).await.expect("store");
        let connection = store
            .save_google_oauth_connection(SaveGoogleOAuthConnection {
                access_token: "access-token".to_string(),
                refresh_token: Some("refresh-token".to_string()),
                token_type: "Bearer".to_string(),
                scopes: vec!["scope:a".to_string()],
                expires_at: None,
            })
            .await
            .expect("saved connection");

        let success = store
            .save_gmail_sync_success(connection.id, Some("history-1"))
            .await
            .expect("saved success");

        assert_eq!(success.last_history_id.as_deref(), Some("history-1"));
        assert!(success.last_synced_at.is_some());
        assert_eq!(success.last_error, None);

        let failure = store
            .save_gmail_sync_failure(connection.id, "boom")
            .await
            .expect("saved failure");

        assert_eq!(failure.last_history_id.as_deref(), Some("history-1"));
        assert_eq!(failure.last_error.as_deref(), Some("boom"));
    }

    #[tokio::test]
    async fn ctl_store_deletes_google_oauth_connection_cascade() {
        let tempdir = tempdir().expect("tempdir");
        let db_path = tempdir.path().join("control.db");
        let store = CtlStore::open(&db_path).await.expect("store");
        let connection = store
            .save_google_oauth_connection(SaveGoogleOAuthConnection {
                access_token: "access-token".to_string(),
                refresh_token: Some("refresh-token".to_string()),
                token_type: "Bearer".to_string(),
                scopes: vec!["scope:a".to_string()],
                expires_at: None,
            })
            .await
            .expect("saved connection");

        store
            .save_google_calendar_resources(
                connection.id,
                vec![DiscoveredGoogleCalendarResource {
                    calendar_id: "primary".to_string(),
                    summary: "Primary".to_string(),
                    description: None,
                    time_zone: Some("Europe/Prague".to_string()),
                    primary: true,
                    selected: false,
                }],
            )
            .await
            .expect("saved calendar resources");
        store
            .save_google_calendar_sync_success(connection.id, "primary", Some("sync-token"))
            .await
            .expect("saved sync state");

        let deleted = store
            .delete_google_oauth_connection(connection.id)
            .await
            .expect("deleted connection");

        assert!(deleted);
        assert!(
            store
                .google_oauth_connection_by_id(connection.id)
                .await
                .expect("load deleted connection")
                .is_none()
        );
        assert_eq!(
            store
                .list_google_calendar_resources(connection.id)
                .await
                .expect("list resources after delete")
                .len(),
            0
        );
        assert!(
            store
                .google_calendar_sync_state(connection.id, "primary")
                .await
                .expect("sync state after delete")
                .is_none()
        );
        assert!(
            store
                .gmail_sync_state(connection.id)
                .await
                .expect("gmail sync state after delete")
                .is_none()
        );
    }

    #[tokio::test]
    async fn ctl_store_tracks_plex_library_sync_state() {
        let tempdir = tempdir().expect("tempdir");
        let db_path = tempdir.path().join("control.db");
        let store = CtlStore::open(&db_path).await.expect("store");

        let success = store
            .save_plex_library_sync_success("movies", "fingerprint-1")
            .await
            .expect("saved success");

        assert_eq!(success.library_key, "movies");
        assert_eq!(
            success.content_fingerprint.as_deref(),
            Some("fingerprint-1")
        );
        assert!(success.last_synced_at.is_some());
        assert_eq!(success.last_error, None);

        let failure = store
            .save_plex_library_sync_failure("movies", "boom")
            .await
            .expect("saved failure");

        assert_eq!(
            failure.content_fingerprint.as_deref(),
            Some("fingerprint-1")
        );
        assert_eq!(failure.last_error.as_deref(), Some("boom"));
    }

    #[tokio::test]
    async fn ctl_store_persists_plex_connections() {
        let tempdir = tempdir().expect("tempdir");
        let db_path = tempdir.path().join("control.db");
        let store = CtlStore::open(&db_path).await.expect("store");

        let first = store
            .save_plex_connection(SavePlexConnection {
                name: "Local Plex".to_string(),
                machine_identifier: "machine-1".to_string(),
                base_url: "http://127.0.0.1:32400".to_string(),
                token: "token-a".to_string(),
                libraries: vec!["Movies".to_string(), "Shows".to_string()],
            })
            .await
            .expect("saved first");
        let second = store
            .save_plex_connection(SavePlexConnection {
                name: "Remote Plex".to_string(),
                machine_identifier: "machine-2".to_string(),
                base_url: "http://127.0.0.2:32400".to_string(),
                token: "token-b".to_string(),
                libraries: vec!["Anime".to_string()],
            })
            .await
            .expect("saved second");

        let all = store.list_plex_connections().await.expect("list");
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, second.id);
        assert_eq!(all[0].name, "Remote Plex");
        assert_eq!(all[0].machine_identifier.as_deref(), Some("machine-2"));
        assert_eq!(all[0].libraries, vec!["Anime"]);
        assert_eq!(all[1].id, first.id);
        assert_eq!(all[1].name, "Local Plex");
        assert_eq!(all[1].machine_identifier.as_deref(), Some("machine-1"));
        assert_eq!(all[1].libraries, vec!["Movies", "Shows"]);

        let updated = store
            .save_plex_connection(SavePlexConnection {
                name: "Local Plex Updated".to_string(),
                machine_identifier: "machine-1".to_string(),
                base_url: "http://127.0.0.9:32400".to_string(),
                token: "token-c".to_string(),
                libraries: vec!["Movies".to_string()],
            })
            .await
            .expect("updated");
        assert_eq!(updated.id, first.id);
        assert_eq!(updated.name, "Local Plex Updated");
        assert_eq!(updated.machine_identifier.as_deref(), Some("machine-1"));
        assert_eq!(updated.base_url, "http://127.0.0.9:32400");
        assert_eq!(updated.token, "token-c");
        assert_eq!(updated.libraries, vec!["Movies"]);

        let deleted = store
            .delete_plex_connection(second.id)
            .await
            .expect("delete");
        assert!(deleted);
        let remaining = store.list_plex_connections().await.expect("remaining");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, first.id);
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

fn decode_google_calendar_resource(
    row: sqlx::sqlite::SqliteRow,
) -> CtlResult<GoogleCalendarResource> {
    use sqlx::Row;

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

    Ok(GoogleCalendarResource {
        id: row
            .try_get("id")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        connection_id: row
            .try_get("connection_id")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        calendar_id: row
            .try_get("calendar_id")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        summary: row
            .try_get("summary")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        description: row
            .try_get("description")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        time_zone: row
            .try_get("time_zone")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        primary: row
            .try_get("primary_calendar")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        selected: row
            .try_get("selected")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        created_at,
        updated_at,
    })
}

fn decode_google_calendar_sync_state(
    row: sqlx::sqlite::SqliteRow,
) -> CtlResult<GoogleCalendarSyncState> {
    use sqlx::Row;

    let last_synced_at = row
        .try_get::<Option<String>, _>("last_synced_at")
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

    Ok(GoogleCalendarSyncState {
        id: row
            .try_get("id")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        connection_id: row
            .try_get("connection_id")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        calendar_id: row
            .try_get("calendar_id")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        next_sync_token: row
            .try_get("next_sync_token")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        last_synced_at,
        last_error: row
            .try_get("last_error")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        created_at,
        updated_at,
    })
}

fn decode_gmail_sync_state(row: sqlx::sqlite::SqliteRow) -> CtlResult<GmailSyncState> {
    use sqlx::Row;

    let last_synced_at = row
        .try_get::<Option<String>, _>("last_synced_at")
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

    Ok(GmailSyncState {
        id: row
            .try_get("id")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        connection_id: row
            .try_get("connection_id")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        last_history_id: row
            .try_get("last_history_id")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        last_synced_at,
        last_error: row
            .try_get("last_error")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        created_at,
        updated_at,
    })
}

fn decode_plex_library_sync_state(row: sqlx::sqlite::SqliteRow) -> CtlResult<PlexLibrarySyncState> {
    use sqlx::Row;

    let last_synced_at = row
        .try_get::<Option<String>, _>("last_synced_at")
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

    Ok(PlexLibrarySyncState {
        id: row
            .try_get("id")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        library_key: row
            .try_get("library_key")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        content_fingerprint: row
            .try_get("content_fingerprint")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        last_synced_at,
        last_error: row
            .try_get("last_error")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        created_at,
        updated_at,
    })
}

fn decode_plex_connection(row: sqlx::sqlite::SqliteRow) -> CtlResult<PlexConnection> {
    use sqlx::Row;

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
    let libraries = row
        .try_get::<String, _>("libraries")
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

    Ok(PlexConnection {
        id: row
            .try_get("id")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        name: row
            .try_get("name")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        machine_identifier: row
            .try_get("machine_identifier")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        base_url: row
            .try_get("base_url")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        token: row
            .try_get("token")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        libraries: if libraries.is_empty() {
            Vec::new()
        } else {
            libraries.lines().map(str::to_string).collect()
        },
        created_at,
        updated_at,
    })
}
