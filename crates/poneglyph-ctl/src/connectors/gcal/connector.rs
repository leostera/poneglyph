use derive_builder::Builder;
use poneglyph::{Fact, Poneglyph};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::{CtlError, CtlResult, CtlStore, GoogleCalendarResource, GoogleOAuthConnection};

use super::client::GcalClient;
use super::ingestor::facts_for_selected_calendars;
use super::schema::schema_facts;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, Builder)]
#[builder(pattern = "owned")]
pub struct GcalConfig {
    #[serde(default)]
    #[builder(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone)]
pub struct GcalConnector {
    config: GcalConfig,
}

impl GcalConnector {
    pub fn init(config: GcalConfig) -> CtlResult<Self> {
        Ok(Self { config })
    }

    pub fn name(&self) -> &'static str {
        "gcal"
    }

    pub fn config(&self) -> &GcalConfig {
        &self.config
    }

    pub fn schema_namespace(&self) -> &'static str {
        "gcal"
    }

    pub fn schema_facts(&self) -> Vec<Fact> {
        schema_facts()
    }

    pub async fn run(
        self,
        store: CtlStore,
        poneglyph: Arc<Poneglyph>,
        fact_tx: mpsc::Sender<Vec<Fact>>,
    ) -> CtlResult<()> {
        let connections = store.list_google_oauth_connections().await?;
        if connections.is_empty() {
            info!("gcal connector has no saved google connections");
            return Ok(());
        }

        let client = GcalClient::default();
        let mut calendars_to_emit = Vec::new();
        let mut events_by_calendar = HashMap::new();
        let mut selected_calendar_count = 0usize;

        for connection in connections {
            let calendars = store
                .list_google_calendar_resources(connection.id)
                .await?
                .into_iter()
                .filter(|calendar| calendar.selected)
                .map(|calendar| GoogleCalendarResource {
                    calendar_id: calendar.calendar_id,
                    summary: calendar.summary,
                    description: calendar.description,
                    time_zone: calendar.time_zone,
                    primary: calendar.primary,
                    selected: calendar.selected,
                })
                .collect::<Vec<_>>();

            if calendars.is_empty() {
                continue;
            }

            selected_calendar_count += calendars.len();

            for calendar in &calendars {
                let sync_state = store
                    .google_calendar_sync_state(connection.id, &calendar.calendar_id)
                    .await?;
                let sync_token = sync_state
                    .as_ref()
                    .and_then(|state| state.next_sync_token.as_deref());

                let sync = match client
                    .sync_events(&connection.access_token, &calendar.calendar_id, sync_token)
                    .await
                {
                    Ok(sync) => sync,
                    Err(CtlError::GcalSyncTokenExpired) => {
                        warn!(
                            connection_id = connection.id,
                            calendar_id = %calendar.calendar_id,
                            "gcal sync token expired, falling back to full calendar sync"
                        );
                        client
                            .sync_events(&connection.access_token, &calendar.calendar_id, None)
                            .await?
                    }
                    Err(error) => {
                        let _ = store
                            .save_google_calendar_sync_failure(
                                connection.id,
                                &calendar.calendar_id,
                                &error.to_string(),
                            )
                            .await;
                        return Err(error);
                    }
                };
                store
                    .save_google_calendar_sync_success(
                        connection.id,
                        &calendar.calendar_id,
                        sync.next_sync_token.as_deref(),
                    )
                    .await?;
                let should_emit_calendar = sync_token.is_none() || !sync.events.is_empty();
                if should_emit_calendar {
                    calendars_to_emit.push(calendar.clone());
                }
                if !sync.events.is_empty() {
                    events_by_calendar.insert(calendar.calendar_id.clone(), sync.events);
                }
            }
        }

        if selected_calendar_count == 0 {
            info!("gcal connector has no selected calendars to sync");
            return Ok(());
        }

        let facts =
            facts_for_selected_calendars(&poneglyph, calendars_to_emit, events_by_calendar).await?;
        if facts.is_empty() {
            info!("gcal connector produced no facts for selected calendars");
            return Ok(());
        }
        let fact_count = facts.len();
        fact_tx
            .send(facts)
            .await
            .map_err(|error| CtlError::GcalRequest(error.to_string()))?;
        info!(fact_count, "gcal connector synced selected calendars");
        Ok(())
    }

    pub async fn discover_calendars(
        &self,
        store: &CtlStore,
    ) -> CtlResult<Vec<GoogleCalendarResource>> {
        let connection = store
            .latest_google_oauth_connection()
            .await?
            .ok_or(CtlError::MissingGoogleOAuthConnection)?;
        self.discover_calendars_for_connection(&connection, store)
            .await
    }

    pub async fn discover_calendars_for_connection_id(
        &self,
        store: &CtlStore,
        connection_id: i64,
    ) -> CtlResult<Vec<GoogleCalendarResource>> {
        let connection = store
            .google_oauth_connection_by_id(connection_id)
            .await?
            .ok_or(CtlError::MissingGoogleOAuthConnection)?;

        self.discover_calendars_for_connection(&connection, store)
            .await
    }

    pub async fn discover_calendars_for_connection(
        &self,
        connection: &GoogleOAuthConnection,
        store: &CtlStore,
    ) -> CtlResult<Vec<GoogleCalendarResource>> {
        let calendars = GcalClient::default()
            .list_calendars(&connection.access_token)
            .await?;
        store
            .save_google_calendar_resources(connection.id, calendars.clone())
            .await?;
        Ok(calendars)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::{
        Json, Router,
        extract::{Query, State},
        routing::get,
    };
    use poneglyph::{FactService, InMemoryFactStore, Poneglyph, Value, Workspace};
    use serde::Deserialize;
    use tokio::sync::Mutex as TokioMutex;
    use tokio::sync::mpsc;

    use crate::CtlStore;

    use super::{GcalConfig, GcalConnector};

    fn next_http_bind_addr() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("ephemeral tcp listener");
        let addr = listener.local_addr().expect("local addr");
        drop(listener);
        addr.to_string()
    }

    #[test]
    fn gcal_connector_initializes_with_valid_config() {
        let connector = GcalConnector::init(GcalConfig { enabled: true }).expect("connector");

        assert_eq!(connector.name(), "gcal");
        assert_eq!(connector.schema_namespace(), "gcal");
    }

    #[tokio::test]
    async fn gcal_connector_syncs_selected_calendar_events() {
        let _guard = crate::test_env_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let bind_addr = next_http_bind_addr();
        let listener = tokio::net::TcpListener::bind(&bind_addr)
            .await
            .expect("listener");
        let server = tokio::spawn(async move {
            let app = Router::new().route(
                "/calendar/v3/calendars/primary/events",
                get(|| async {
                    Json(serde_json::json!({
                        "items": [
                            {
                                "id": "event-1",
                                "status": "confirmed",
                                "summary": "Standup",
                                "description": "Daily sync",
                                "htmlLink": "https://calendar.google.com/event?eid=1",
                                "start": { "dateTime": "2026-03-18T09:00:00Z" },
                                "end": { "dateTime": "2026-03-18T09:30:00Z" }
                            }
                        ]
                    }))
                }),
            );
            axum::serve(listener, app).await.expect("serve");
        });

        // SAFETY: guarded by env_lock() so no concurrent mutation occurs in tests.
        unsafe {
            std::env::set_var("PONEGLYPH_GCAL_API_BASE_URL", format!("http://{bind_addr}"));
        }

        let tempdir = tempfile::tempdir().expect("tempdir");
        let ctl = CtlStore::open(tempdir.path().join("control.db"))
            .await
            .expect("ctl");
        let connection = ctl
            .save_google_oauth_connection(crate::SaveGoogleOAuthConnection {
                access_token: "google-access-token".to_string(),
                refresh_token: Some("google-refresh-token".to_string()),
                token_type: "Bearer".to_string(),
                scopes: vec!["https://www.googleapis.com/auth/calendar.readonly".to_string()],
                expires_at: None,
            })
            .await
            .expect("connection");
        ctl.save_google_calendar_resources(
            connection.id,
            vec![crate::GoogleCalendarResource {
                calendar_id: "primary".to_string(),
                summary: "Primary".to_string(),
                description: Some("Main".to_string()),
                time_zone: Some("Europe/Prague".to_string()),
                primary: true,
                selected: true,
            }],
        )
        .await
        .expect("save calendars");
        ctl.set_google_calendar_selection(connection.id, &["primary".to_string()])
            .await
            .expect("select calendar");

        let facts = Arc::new(
            FactService::builder()
                .with_store(InMemoryFactStore::new())
                .build()
                .expect("facts"),
        );
        let tempdir = tempfile::tempdir().expect("tempdir");
        let poneglyph = Arc::new(
            Poneglyph::builder()
                .with_workspace(Workspace::at(tempdir.path()))
                .with_fact_service_arc(facts)
                .build()
                .await
                .expect("poneglyph"),
        );
        let connector = GcalConnector::init(GcalConfig { enabled: true }).expect("connector");
        let (tx, mut rx) = mpsc::channel(1);

        connector
            .run(ctl.clone(), poneglyph, tx)
            .await
            .expect("sync");

        let batch = rx.recv().await.expect("fact batch");
        assert!(
            batch
                .iter()
                .any(|fact| fact.field == poneglyph::uri!("gcal:eventId")
                    && fact.value == Value::text("event-1"))
        );
        assert!(
            batch
                .iter()
                .any(|fact| fact.field == poneglyph::uri!("gcal:calendarId")
                    && fact.value == Value::text("primary"))
        );
        let sync_state = ctl
            .google_calendar_sync_state(connection.id, "primary")
            .await
            .expect("sync state")
            .expect("saved sync state");
        assert!(sync_state.last_synced_at.is_some());
        assert_eq!(sync_state.last_error, None);

        // SAFETY: guarded by env_lock() so no concurrent mutation occurs in tests.
        unsafe {
            std::env::remove_var("PONEGLYPH_GCAL_API_BASE_URL");
        }
        server.abort();
    }

    #[derive(Debug, Default, Deserialize)]
    struct EventQuery {
        #[serde(rename = "syncToken")]
        sync_token: Option<String>,
    }

    #[tokio::test]
    async fn gcal_connector_uses_saved_sync_token_on_subsequent_runs() {
        let _guard = crate::test_env_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let bind_addr = next_http_bind_addr();
        let observed_sync_tokens = Arc::new(TokioMutex::new(Vec::<Option<String>>::new()));
        let listener = tokio::net::TcpListener::bind(&bind_addr)
            .await
            .expect("listener");
        let server_observed_sync_tokens = observed_sync_tokens.clone();
        let server = tokio::spawn(async move {
            async fn events(
                State(observed): State<Arc<TokioMutex<Vec<Option<String>>>>>,
                Query(query): Query<EventQuery>,
            ) -> Json<serde_json::Value> {
                observed.lock().await.push(query.sync_token.clone());
                let payload = match query.sync_token.as_deref() {
                    Some("sync-token-1") => serde_json::json!({
                        "items": [],
                        "nextSyncToken": "sync-token-2"
                    }),
                    _ => serde_json::json!({
                        "items": [
                            {
                                "id": "event-1",
                                "status": "confirmed",
                                "summary": "Standup",
                                "description": "Daily sync",
                                "htmlLink": "https://calendar.google.com/event?eid=1",
                                "start": { "dateTime": "2026-03-18T09:00:00Z" },
                                "end": { "dateTime": "2026-03-18T09:30:00Z" }
                            }
                        ],
                        "nextSyncToken": "sync-token-1"
                    }),
                };
                Json(payload)
            }

            let app = Router::new()
                .route("/calendar/v3/calendars/primary/events", get(events))
                .with_state(server_observed_sync_tokens);
            axum::serve(listener, app).await.expect("serve");
        });

        // SAFETY: guarded by env_lock() so no concurrent mutation occurs in tests.
        unsafe {
            std::env::set_var("PONEGLYPH_GCAL_API_BASE_URL", format!("http://{bind_addr}"));
        }

        let tempdir = tempfile::tempdir().expect("tempdir");
        let ctl = CtlStore::open(tempdir.path().join("control.db"))
            .await
            .expect("ctl");
        let connection = ctl
            .save_google_oauth_connection(crate::SaveGoogleOAuthConnection {
                access_token: "google-access-token".to_string(),
                refresh_token: Some("google-refresh-token".to_string()),
                token_type: "Bearer".to_string(),
                scopes: vec!["https://www.googleapis.com/auth/calendar.readonly".to_string()],
                expires_at: None,
            })
            .await
            .expect("connection");
        ctl.save_google_calendar_resources(
            connection.id,
            vec![crate::GoogleCalendarResource {
                calendar_id: "primary".to_string(),
                summary: "Primary".to_string(),
                description: Some("Main".to_string()),
                time_zone: Some("Europe/Prague".to_string()),
                primary: true,
                selected: true,
            }],
        )
        .await
        .expect("save calendars");
        ctl.set_google_calendar_selection(connection.id, &["primary".to_string()])
            .await
            .expect("select calendar");

        let facts = Arc::new(
            FactService::builder()
                .with_store(InMemoryFactStore::new())
                .build()
                .expect("facts"),
        );
        let tempdir = tempfile::tempdir().expect("tempdir");
        let poneglyph = Arc::new(
            Poneglyph::builder()
                .with_workspace(Workspace::at(tempdir.path()))
                .with_fact_service_arc(facts)
                .build()
                .await
                .expect("poneglyph"),
        );
        let connector = GcalConnector::init(GcalConfig { enabled: true }).expect("connector");

        let (tx1, mut rx1) = mpsc::channel(1);
        connector
            .clone()
            .run(ctl.clone(), poneglyph.clone(), tx1)
            .await
            .expect("first sync");
        let _ = rx1.recv().await.expect("first fact batch");

        let first_state = ctl
            .google_calendar_sync_state(connection.id, "primary")
            .await
            .expect("first state")
            .expect("saved first state");
        assert_eq!(first_state.next_sync_token.as_deref(), Some("sync-token-1"));

        let (tx2, mut rx2) = mpsc::channel(1);
        connector
            .run(ctl.clone(), poneglyph, tx2)
            .await
            .expect("second sync");
        assert!(rx2.recv().await.is_none());

        let second_state = ctl
            .google_calendar_sync_state(connection.id, "primary")
            .await
            .expect("second state")
            .expect("saved second state");
        assert_eq!(
            second_state.next_sync_token.as_deref(),
            Some("sync-token-2")
        );

        let observed = observed_sync_tokens.lock().await.clone();
        assert_eq!(observed, vec![None, Some("sync-token-1".to_string())]);

        // SAFETY: guarded by env_lock() so no concurrent mutation occurs in tests.
        unsafe {
            std::env::remove_var("PONEGLYPH_GCAL_API_BASE_URL");
        }
        server.abort();
    }
}
