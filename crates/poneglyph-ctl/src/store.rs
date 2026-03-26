use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

use crate::{CtlError, CtlResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoogleOAuthConnection {
    pub id: i64,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub token_type: String,
    pub account_email: Option<String>,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilesystemConnection {
    pub id: i64,
    pub name: String,
    pub root_path: String,
    pub canonical_root_path: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveFilesystemConnection {
    pub name: String,
    pub root_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilesystemPathState {
    pub id: i64,
    pub connection_id: i64,
    pub relative_path: String,
    pub last_content_hash: Option<String>,
    pub last_seen_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiProviderConfig {
    pub id: i64,
    pub provider_key: String,
    pub display_name: String,
    pub base_url: String,
    pub default_model: String,
    pub api_key: String,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveAiProviderConfig {
    pub provider_key: String,
    pub display_name: String,
    pub base_url: String,
    pub default_model: String,
    pub api_key: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentAuditRun {
    pub id: String,
    pub agent_key: String,
    pub session_id: Option<String>,
    pub source: String,
    pub status: String,
    pub input_summary: Option<String>,
    pub reply_summary: Option<String>,
    pub error_summary: Option<String>,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentAuditEvent {
    pub id: String,
    pub run_id: String,
    pub seq: i64,
    pub event_type: String,
    pub payload: JsonValue,
    pub occurred_at: DateTime<Utc>,
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
                account_email,
                scopes,
                expires_at,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
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
                account_email,
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
                account_email,
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
                account_email,
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

    pub async fn set_google_oauth_connection_account_email(
        &self,
        id: i64,
        account_email: &str,
    ) -> CtlResult<()> {
        let result = sqlx::query(
            r#"
            UPDATE google_oauth_connections
            SET account_email = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(account_email)
        .bind(Utc::now().to_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(CtlError::StoreQuery(format!(
                "google oauth connection not found: {id}"
            )));
        }

        Ok(())
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

    pub async fn save_filesystem_connection(
        &self,
        connection: SaveFilesystemConnection,
    ) -> CtlResult<FilesystemConnection> {
        if connection.name.trim().is_empty() {
            return Err(CtlError::StoreQuery(
                "filesystem connection name is required".to_string(),
            ));
        }

        let (root_path, canonical_root_path) =
            normalize_filesystem_root_path(connection.root_path.as_str())?;

        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO filesystem_connections (
                name,
                root_path,
                canonical_root_path,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(canonical_root_path) DO UPDATE SET
                name = excluded.name,
                root_path = excluded.root_path,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(connection.name)
        .bind(root_path)
        .bind(canonical_root_path.clone())
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        self.filesystem_connection_by_canonical_root_path(canonical_root_path.as_str())
            .await?
            .ok_or_else(|| CtlError::StoreQuery("saved filesystem connection missing".into()))
    }

    pub async fn list_filesystem_connections(&self) -> CtlResult<Vec<FilesystemConnection>> {
        let rows = sqlx::query(
            r#"
            SELECT
                id,
                name,
                root_path,
                canonical_root_path,
                created_at,
                updated_at
            FROM filesystem_connections
            ORDER BY id DESC
            "#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        rows.into_iter().map(decode_filesystem_connection).collect()
    }

    pub async fn filesystem_connection_by_canonical_root_path(
        &self,
        canonical_root_path: &str,
    ) -> CtlResult<Option<FilesystemConnection>> {
        let row = sqlx::query(
            r#"
            SELECT
                id,
                name,
                root_path,
                canonical_root_path,
                created_at,
                updated_at
            FROM filesystem_connections
            WHERE canonical_root_path = ?
            "#,
        )
        .bind(canonical_root_path)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        row.map(decode_filesystem_connection).transpose()
    }

    pub async fn delete_filesystem_connection(&self, id: i64) -> CtlResult<bool> {
        let result = sqlx::query(
            r#"
            DELETE FROM filesystem_connections
            WHERE id = ?
            "#,
        )
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        Ok(result.rows_affected() > 0)
    }

    pub async fn filesystem_path_state(
        &self,
        connection_id: i64,
        relative_path: &str,
    ) -> CtlResult<Option<FilesystemPathState>> {
        let row = sqlx::query(
            r#"
            SELECT
                id,
                connection_id,
                relative_path,
                last_content_hash,
                last_seen_at,
                created_at,
                updated_at
            FROM filesystem_path_state
            WHERE connection_id = ? AND relative_path = ?
            "#,
        )
        .bind(connection_id)
        .bind(relative_path)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        row.map(decode_filesystem_path_state).transpose()
    }

    pub async fn save_filesystem_path_state(
        &self,
        connection_id: i64,
        relative_path: &str,
        last_content_hash: Option<&str>,
    ) -> CtlResult<FilesystemPathState> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO filesystem_path_state (
                connection_id,
                relative_path,
                last_content_hash,
                last_seen_at,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(connection_id, relative_path) DO UPDATE SET
                last_content_hash = excluded.last_content_hash,
                last_seen_at = excluded.last_seen_at,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(connection_id)
        .bind(relative_path)
        .bind(last_content_hash)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        self.filesystem_path_state(connection_id, relative_path)
            .await?
            .ok_or_else(|| CtlError::StoreQuery("saved filesystem path state missing".into()))
    }

    pub async fn save_ai_provider_config(
        &self,
        config: SaveAiProviderConfig,
    ) -> CtlResult<AiProviderConfig> {
        if config.provider_key.trim().is_empty() {
            return Err(CtlError::StoreQuery(
                "ai provider key is required".to_string(),
            ));
        }
        if config.display_name.trim().is_empty() {
            return Err(CtlError::StoreQuery(
                "ai provider display name is required".to_string(),
            ));
        }
        if config.base_url.trim().is_empty() {
            return Err(CtlError::StoreQuery(
                "ai provider base url is required".to_string(),
            ));
        }
        if config.default_model.trim().is_empty() {
            return Err(CtlError::StoreQuery(
                "ai provider default model is required".to_string(),
            ));
        }
        if config.api_key.trim().is_empty() {
            return Err(CtlError::StoreQuery(
                "ai provider api key is required".to_string(),
            ));
        }

        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO ai_provider_configs (
                provider_key,
                display_name,
                base_url,
                default_model,
                api_key,
                enabled,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider_key) DO UPDATE SET
                display_name = excluded.display_name,
                base_url = excluded.base_url,
                default_model = excluded.default_model,
                api_key = excluded.api_key,
                enabled = excluded.enabled,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(config.provider_key.as_str())
        .bind(config.display_name.as_str())
        .bind(config.base_url.as_str())
        .bind(config.default_model.as_str())
        .bind(config.api_key.as_str())
        .bind(if config.enabled { 1_i64 } else { 0_i64 })
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        self.ai_provider_config_by_key(config.provider_key.as_str())
            .await?
            .ok_or_else(|| CtlError::StoreQuery("saved ai provider missing".into()))
    }

    pub async fn list_ai_provider_configs(&self) -> CtlResult<Vec<AiProviderConfig>> {
        let rows = sqlx::query(
            r#"
            SELECT
                id,
                provider_key,
                display_name,
                base_url,
                default_model,
                api_key,
                enabled,
                created_at,
                updated_at
            FROM ai_provider_configs
            ORDER BY id ASC
            "#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        rows.into_iter().map(decode_ai_provider_config).collect()
    }

    pub async fn ai_provider_config_by_key(
        &self,
        provider_key: &str,
    ) -> CtlResult<Option<AiProviderConfig>> {
        let row = sqlx::query(
            r#"
            SELECT
                id,
                provider_key,
                display_name,
                base_url,
                default_model,
                api_key,
                enabled,
                created_at,
                updated_at
            FROM ai_provider_configs
            WHERE provider_key = ?
            "#,
        )
        .bind(provider_key)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        row.map(decode_ai_provider_config).transpose()
    }

    pub async fn enabled_ai_provider_config(&self) -> CtlResult<Option<AiProviderConfig>> {
        let row = sqlx::query(
            r#"
            SELECT
                id,
                provider_key,
                display_name,
                base_url,
                default_model,
                api_key,
                enabled,
                created_at,
                updated_at
            FROM ai_provider_configs
            WHERE enabled = 1
            ORDER BY id ASC
            LIMIT 1
            "#,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        row.map(decode_ai_provider_config).transpose()
    }

    pub async fn delete_ai_provider_config(&self, id: i64) -> CtlResult<bool> {
        let result = sqlx::query(
            r#"
            DELETE FROM ai_provider_configs
            WHERE id = ?
            "#,
        )
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        Ok(result.rows_affected() > 0)
    }

    pub async fn create_agent_audit_run(&self, run: &AgentAuditRun) -> CtlResult<AgentAuditRun> {
        sqlx::query(
            r#"
            INSERT INTO agent_audit_runs (
                id,
                agent_key,
                session_id,
                source,
                status,
                input_summary,
                reply_summary,
                error_summary,
                started_at,
                finished_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&run.id)
        .bind(&run.agent_key)
        .bind(&run.session_id)
        .bind(&run.source)
        .bind(&run.status)
        .bind(&run.input_summary)
        .bind(&run.reply_summary)
        .bind(&run.error_summary)
        .bind(run.started_at.to_rfc3339())
        .bind(run.finished_at.map(|value| value.to_rfc3339()))
        .execute(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        self.agent_audit_run_by_id(run.id.as_str())
            .await?
            .ok_or_else(|| CtlError::StoreQuery("created agent audit run missing".to_string()))
    }

    pub async fn finish_agent_audit_run(
        &self,
        run_id: &str,
        status: &str,
        reply_summary: Option<&str>,
        error_summary: Option<&str>,
    ) -> CtlResult<Option<AgentAuditRun>> {
        let finished_at = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            UPDATE agent_audit_runs
            SET status = ?,
                reply_summary = ?,
                error_summary = ?,
                finished_at = ?
            WHERE id = ?
            "#,
        )
        .bind(status)
        .bind(reply_summary)
        .bind(error_summary)
        .bind(&finished_at)
        .bind(run_id)
        .execute(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        self.agent_audit_run_by_id(run_id).await
    }

    pub async fn list_agent_audit_runs(
        &self,
        limit: usize,
        offset: usize,
    ) -> CtlResult<Vec<AgentAuditRun>> {
        let rows = sqlx::query(
            r#"
            SELECT
                id,
                agent_key,
                session_id,
                source,
                status,
                input_summary,
                reply_summary,
                error_summary,
                started_at,
                finished_at
            FROM agent_audit_runs
            ORDER BY started_at DESC
            LIMIT ? OFFSET ?
            "#,
        )
        .bind(limit as i64)
        .bind(offset as i64)
        .fetch_all(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        rows.into_iter().map(decode_agent_audit_run).collect()
    }

    pub async fn agent_audit_run_by_id(&self, run_id: &str) -> CtlResult<Option<AgentAuditRun>> {
        let row = sqlx::query(
            r#"
            SELECT
                id,
                agent_key,
                session_id,
                source,
                status,
                input_summary,
                reply_summary,
                error_summary,
                started_at,
                finished_at
            FROM agent_audit_runs
            WHERE id = ?
            "#,
        )
        .bind(run_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        row.map(decode_agent_audit_run).transpose()
    }

    pub async fn append_agent_audit_event(
        &self,
        event: &AgentAuditEvent,
    ) -> CtlResult<AgentAuditEvent> {
        let payload = serde_json::to_string(&event.payload)
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?;
        sqlx::query(
            r#"
            INSERT INTO agent_audit_events (
                id,
                run_id,
                seq,
                event_type,
                payload_json,
                occurred_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&event.id)
        .bind(&event.run_id)
        .bind(event.seq)
        .bind(&event.event_type)
        .bind(payload)
        .bind(event.occurred_at.to_rfc3339())
        .execute(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        Ok(event.clone())
    }

    pub async fn agent_audit_events(&self, run_id: &str) -> CtlResult<Vec<AgentAuditEvent>> {
        let rows = sqlx::query(
            r#"
            SELECT
                id,
                run_id,
                seq,
                event_type,
                payload_json,
                occurred_at
            FROM agent_audit_events
            WHERE run_id = ?
            ORDER BY seq ASC
            "#,
        )
        .bind(run_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?;

        rows.into_iter().map(decode_agent_audit_event).collect()
    }
}

fn resolve_db_path(path: &Path) -> PathBuf {
    if path.extension().is_some() {
        path.to_path_buf()
    } else {
        path.join("control.db")
    }
}

fn normalize_filesystem_root_path(root_path: &str) -> CtlResult<(String, String)> {
    let trimmed = root_path.trim();
    if trimmed.is_empty() {
        return Err(CtlError::StoreQuery(
            "filesystem connection root path is required".to_string(),
        ));
    }

    let as_path = PathBuf::from(trimmed);
    let absolute = if as_path.is_absolute() {
        as_path
    } else {
        std::env::current_dir()
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?
            .join(as_path)
    };
    let canonical = absolute
        .canonicalize()
        .map_err(|error| CtlError::StoreQuery(format!("invalid filesystem root path: {error}")))?;
    if !canonical.is_dir() {
        return Err(CtlError::StoreQuery(
            "filesystem root path must be a directory".to_string(),
        ));
    }

    Ok((
        absolute.to_string_lossy().to_string(),
        canonical.to_string_lossy().to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::{
        AgentAuditEvent, AgentAuditRun, CtlStore, SaveAiProviderConfig, SaveFilesystemConnection,
        SaveGoogleOAuthConnection, SavePlexConnection,
    };
    use crate::connectors::gcal::GoogleCalendarResource as DiscoveredGoogleCalendarResource;
    use chrono::Utc;
    use serde_json::json;

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
        assert_eq!(latest.account_email, None);
        assert_eq!(latest.scopes, vec!["scope:a", "scope:b"]);
        assert_eq!(latest.expires_at, Some(expires_at));
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0].id, saved.id);
    }

    #[tokio::test]
    async fn ctl_store_sets_google_oauth_connection_account_email() {
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
            .set_google_oauth_connection_account_email(connection.id, "alice@example.com")
            .await
            .expect("set account email");

        let updated = store
            .google_oauth_connection_by_id(connection.id)
            .await
            .expect("load updated connection")
            .expect("connection exists");
        assert_eq!(updated.account_email.as_deref(), Some("alice@example.com"));
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
        store
            .save_gmail_sync_success(connection.id, Some("history-1"))
            .await
            .expect("saved gmail sync state");

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

    #[tokio::test]
    async fn ctl_store_persists_filesystem_connections() {
        let tempdir = tempdir().expect("tempdir");
        let db_path = tempdir.path().join("control.db");
        let store = CtlStore::open(&db_path).await.expect("store");

        let root = tempdir.path().join("documents");
        std::fs::create_dir_all(&root).expect("create root");

        let first = store
            .save_filesystem_connection(SaveFilesystemConnection {
                name: "Documents".to_string(),
                root_path: root.to_string_lossy().to_string(),
            })
            .await
            .expect("save connection");

        let second = store
            .save_filesystem_connection(SaveFilesystemConnection {
                name: "Documents Updated".to_string(),
                root_path: root.to_string_lossy().to_string(),
            })
            .await
            .expect("upsert connection");

        assert_eq!(first.id, second.id);
        assert_eq!(second.name, "Documents Updated");
        let all = store.list_filesystem_connections().await.expect("list");
        assert_eq!(all.len(), 1);
        assert_eq!(
            all[0].canonical_root_path,
            root.canonicalize()
                .expect("canonical root")
                .to_string_lossy()
                .to_string()
        );

        let deleted = store
            .delete_filesystem_connection(second.id)
            .await
            .expect("delete");
        assert!(deleted);
        assert_eq!(
            store
                .list_filesystem_connections()
                .await
                .expect("list after delete")
                .len(),
            0
        );
    }

    #[tokio::test]
    async fn ctl_store_tracks_filesystem_path_state() {
        let tempdir = tempdir().expect("tempdir");
        let db_path = tempdir.path().join("control.db");
        let store = CtlStore::open(&db_path).await.expect("store");

        let root = tempdir.path().join("documents");
        std::fs::create_dir_all(&root).expect("create root");
        let connection = store
            .save_filesystem_connection(SaveFilesystemConnection {
                name: "Documents".to_string(),
                root_path: root.to_string_lossy().to_string(),
            })
            .await
            .expect("save connection");

        let first = store
            .save_filesystem_path_state(connection.id, "notes/today.md", Some("hash-a"))
            .await
            .expect("save first");
        assert_eq!(first.last_content_hash.as_deref(), Some("hash-a"));

        let second = store
            .save_filesystem_path_state(connection.id, "notes/today.md", Some("hash-b"))
            .await
            .expect("save second");
        assert_eq!(second.id, first.id);
        assert_eq!(second.last_content_hash.as_deref(), Some("hash-b"));

        let loaded = store
            .filesystem_path_state(connection.id, "notes/today.md")
            .await
            .expect("load")
            .expect("exists");
        assert_eq!(loaded.id, first.id);
        assert_eq!(loaded.last_content_hash.as_deref(), Some("hash-b"));
    }

    #[tokio::test]
    async fn ctl_store_persists_ai_provider_configs() {
        let tempdir = tempdir().expect("tempdir");
        let db_path = tempdir.path().join("control.db");
        let store = CtlStore::open(&db_path).await.expect("store");

        let saved = store
            .save_ai_provider_config(SaveAiProviderConfig {
                provider_key: "openai".to_string(),
                display_name: "ChatGPT".to_string(),
                base_url: "https://api.openai.com".to_string(),
                default_model: "gpt-test".to_string(),
                api_key: "sk-test".to_string(),
                enabled: true,
            })
            .await
            .expect("save ai provider");

        let listed = store
            .list_ai_provider_configs()
            .await
            .expect("list ai providers");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, saved.id);
        assert_eq!(listed[0].provider_key, "openai");

        let loaded = store
            .enabled_ai_provider_config()
            .await
            .expect("enabled provider")
            .expect("provider exists");
        assert_eq!(loaded.id, saved.id);
        assert_eq!(loaded.default_model, "gpt-test");
    }

    #[tokio::test]
    async fn ctl_store_tracks_agent_audit_runs_and_events() {
        let tempdir = tempdir().expect("tempdir");
        let db_path = tempdir.path().join("control.db");
        let store = CtlStore::open(&db_path).await.expect("store");
        let started_at = Utc::now();

        let run = store
            .create_agent_audit_run(&AgentAuditRun {
                id: "run-1".to_string(),
                agent_key: "poneglyph-agent".to_string(),
                session_id: Some("session-1".to_string()),
                source: "app_chat".to_string(),
                status: "running".to_string(),
                input_summary: Some("hello".to_string()),
                reply_summary: None,
                error_summary: None,
                started_at,
                finished_at: None,
            })
            .await
            .expect("create run");

        let event = store
            .append_agent_audit_event(&AgentAuditEvent {
                id: "event-1".to_string(),
                run_id: run.id.clone(),
                seq: 1,
                event_type: "input_received".to_string(),
                payload: json!({ "message": "hello" }),
                occurred_at: started_at,
            })
            .await
            .expect("append event");
        assert_eq!(event.run_id, run.id);

        let finished = store
            .finish_agent_audit_run(&run.id, "succeeded", Some("hi there"), None)
            .await
            .expect("finish run")
            .expect("run exists");
        assert_eq!(finished.status, "succeeded");
        assert_eq!(finished.reply_summary.as_deref(), Some("hi there"));

        let runs = store.list_agent_audit_runs(50, 0).await.expect("list runs");
        assert_eq!(runs.len(), 1);
        let events = store
            .agent_audit_events(&run.id)
            .await
            .expect("list events");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "input_received");
        assert_eq!(events[0].payload, json!({ "message": "hello" }));
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
        account_email: row
            .try_get("account_email")
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

fn decode_filesystem_connection(row: sqlx::sqlite::SqliteRow) -> CtlResult<FilesystemConnection> {
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

    Ok(FilesystemConnection {
        id: row
            .try_get("id")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        name: row
            .try_get("name")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        root_path: row
            .try_get("root_path")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        canonical_root_path: row
            .try_get("canonical_root_path")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        created_at,
        updated_at,
    })
}

fn decode_filesystem_path_state(row: sqlx::sqlite::SqliteRow) -> CtlResult<FilesystemPathState> {
    use sqlx::Row;

    let last_seen_at = DateTime::parse_from_rfc3339(
        &row.try_get::<String, _>("last_seen_at")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
    )
    .map_err(|error| CtlError::StoreQuery(error.to_string()))?
    .with_timezone(&Utc);
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

    Ok(FilesystemPathState {
        id: row
            .try_get("id")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        connection_id: row
            .try_get("connection_id")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        relative_path: row
            .try_get("relative_path")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        last_content_hash: row
            .try_get("last_content_hash")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        last_seen_at,
        created_at,
        updated_at,
    })
}

fn decode_ai_provider_config(row: sqlx::sqlite::SqliteRow) -> CtlResult<AiProviderConfig> {
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

    Ok(AiProviderConfig {
        id: row
            .try_get("id")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        provider_key: row
            .try_get("provider_key")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        display_name: row
            .try_get("display_name")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        base_url: row
            .try_get("base_url")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        default_model: row
            .try_get("default_model")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        api_key: row
            .try_get("api_key")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        enabled: row
            .try_get::<i64, _>("enabled")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?
            != 0,
        created_at,
        updated_at,
    })
}

fn decode_agent_audit_run(row: sqlx::sqlite::SqliteRow) -> CtlResult<AgentAuditRun> {
    use sqlx::Row;

    let started_at = DateTime::parse_from_rfc3339(
        &row.try_get::<String, _>("started_at")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
    )
    .map_err(|error| CtlError::StoreQuery(error.to_string()))?
    .with_timezone(&Utc);
    let finished_at = row
        .try_get::<Option<String>, _>("finished_at")
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?
        .map(|value| DateTime::parse_from_rfc3339(&value))
        .transpose()
        .map_err(|error| CtlError::StoreQuery(error.to_string()))?
        .map(|value| value.with_timezone(&Utc));

    Ok(AgentAuditRun {
        id: row
            .try_get("id")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        agent_key: row
            .try_get("agent_key")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        session_id: row
            .try_get("session_id")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        source: row
            .try_get("source")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        status: row
            .try_get("status")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        input_summary: row
            .try_get("input_summary")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        reply_summary: row
            .try_get("reply_summary")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        error_summary: row
            .try_get("error_summary")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        started_at,
        finished_at,
    })
}

fn decode_agent_audit_event(row: sqlx::sqlite::SqliteRow) -> CtlResult<AgentAuditEvent> {
    use sqlx::Row;

    let occurred_at = DateTime::parse_from_rfc3339(
        &row.try_get::<String, _>("occurred_at")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
    )
    .map_err(|error| CtlError::StoreQuery(error.to_string()))?
    .with_timezone(&Utc);
    let payload = row
        .try_get::<String, _>("payload_json")
        .map_err(|error| CtlError::StoreQuery(error.to_string()))
        .and_then(|value| {
            serde_json::from_str(&value).map_err(|error| CtlError::StoreQuery(error.to_string()))
        })?;

    Ok(AgentAuditEvent {
        id: row
            .try_get("id")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        run_id: row
            .try_get("run_id")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        seq: row
            .try_get("seq")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        event_type: row
            .try_get("event_type")
            .map_err(|error| CtlError::StoreQuery(error.to_string()))?,
        payload,
        occurred_at,
    })
}
