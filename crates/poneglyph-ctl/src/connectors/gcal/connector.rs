use derive_builder::Builder;
use poneglyph::{Fact, Poneglyph};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::info;

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
        if !self.config.enabled {
            info!("gcal connector disabled, skipping");
            return Ok(());
        }

        let connection = store
            .latest_google_oauth_connection()
            .await?
            .ok_or(CtlError::MissingGoogleOAuthConnection)?;
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
            info!("gcal connector has no selected calendars to sync");
            return Ok(());
        }

        let client = GcalClient::default();
        let mut events_by_calendar = HashMap::new();
        for calendar in &calendars {
            let events = client
                .list_events(&connection.access_token, &calendar.calendar_id)
                .await?;
            events_by_calendar.insert(calendar.calendar_id.clone(), events);
        }
        let facts = facts_for_selected_calendars(&poneglyph, calendars, events_by_calendar).await?;
        if facts.is_empty() {
            info!("gcal connector produced no facts for selected calendars");
            return Ok(());
        }
        let fact_count = facts.len();
        fact_tx
            .send(facts)
            .await
            .map_err(|error| CtlError::GcalRequest(error.to_string()))?;
        info!(
            enabled = self.config.enabled,
            fact_count, "gcal connector synced selected calendars"
        );
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
    use std::sync::{Arc, Mutex, OnceLock};

    use axum::{Json, Router, routing::get};
    use poneglyph::{FactService, InMemoryFactStore, Poneglyph, Value};
    use tokio::sync::mpsc;

    use crate::CtlStore;

    use super::{GcalConfig, GcalConnector};

    fn next_http_bind_addr() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("ephemeral tcp listener");
        let addr = listener.local_addr().expect("local addr");
        drop(listener);
        addr.to_string()
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn gcal_connector_initializes_with_valid_config() {
        let connector = GcalConnector::init(GcalConfig { enabled: true }).expect("connector");

        assert_eq!(connector.name(), "gcal");
        assert_eq!(connector.schema_namespace(), "gcal");
    }

    #[tokio::test]
    async fn gcal_connector_syncs_selected_calendar_events() {
        let _guard = env_lock().lock().expect("env lock");
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
        let poneglyph = Arc::new(
            Poneglyph::builder()
                .with_fact_service_arc(facts)
                .build()
                .await
                .expect("poneglyph"),
        );
        let connector = GcalConnector::init(GcalConfig { enabled: true }).expect("connector");
        let (tx, mut rx) = mpsc::channel(1);

        connector.run(ctl, poneglyph, tx).await.expect("sync");

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

        // SAFETY: guarded by env_lock() so no concurrent mutation occurs in tests.
        unsafe {
            std::env::remove_var("PONEGLYPH_GCAL_API_BASE_URL");
        }
        server.abort();
    }
}
