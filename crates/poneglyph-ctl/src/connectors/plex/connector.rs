use derive_builder::Builder;
use poneglyph::Fact;
use serde::{Deserialize, Serialize};
use tokio::time::{Duration, sleep};
use tracing::{debug, info, instrument};

use crate::{CtlError, CtlResult};

use super::client::PlexClient;
use super::ingestor::{library_facts, select_sections};
use super::schema::schema_facts;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, Builder)]
#[builder(pattern = "owned")]
pub struct PlexConfig {
    #[serde(default)]
    #[builder(default)]
    pub enabled: bool,
    #[serde(default)]
    #[builder(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    #[builder(default)]
    pub token: Option<String>,
    #[serde(default)]
    #[builder(default)]
    pub libraries: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct PlexConnector {
    config: PlexConfig,
    client: PlexClient,
}

impl PlexConnector {
    pub fn init(config: PlexConfig) -> CtlResult<Self> {
        let client = PlexClient::new(&config)?;

        if config.enabled && config.base_url.is_none() {
            return Err(CtlError::MissingPlexBaseUrl);
        }

        Ok(Self { config, client })
    }

    pub fn name(&self) -> &'static str {
        "plex"
    }

    pub fn config(&self) -> &PlexConfig {
        &self.config
    }

    pub fn schema_namespace(&self) -> &'static str {
        "plex"
    }

    #[instrument(skip(self), fields(component = "poneglyph-ctl", connector = "plex"))]
    pub async fn run(self) -> CtlResult<Vec<Fact>> {
        if !self.config.enabled {
            info!("plex connector disabled, skipping");
            return Ok(vec![]);
        }

        let sections = self.client.fetch_library_sections().await?;
        let selected_sections = select_sections(&self.config.libraries, sections);
        let libraries_url = self.client.library_sections_url()?;
        let base_url = self
            .client
            .base_url()
            .map(ToString::to_string)
            .unwrap_or_else(|| "<missing>".to_string());
        info!(
            base_url = %base_url,
            libraries_url = %libraries_url,
            selected_library_count = selected_sections.len(),
            "plex connector initialized"
        );

        if !self.config.libraries.is_empty() {
            debug!(libraries = ?self.config.libraries, "plex connector configured libraries");
        }

        sleep(Duration::from_millis(10)).await;
        Ok(schema_facts()
            .into_iter()
            .chain(library_facts(&selected_sections))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::{
        Json, Router,
        extract::{Query, State},
        http::HeaderMap as AxumHeaderMap,
        routing::get,
    };
    use poneglyph::Value;
    use reqwest::header::ACCEPT;
    use serde_json::json;
    use tokio::{net::TcpListener, sync::Mutex};

    use super::{PlexConfig, PlexConnector};

    #[test]
    fn plex_connector_initializes_with_valid_config() {
        let connector = PlexConnector::init(PlexConfig {
            enabled: true,
            base_url: Some("http://127.0.0.1:32400".to_string()),
            token: Some("secret".to_string()),
            libraries: vec!["Movies".to_string()],
        })
        .expect("connector");

        assert_eq!(connector.name(), "plex");
        assert_eq!(connector.schema_namespace(), "plex");
    }

    #[test]
    fn enabled_plex_connector_requires_base_url() {
        let error = PlexConnector::init(PlexConfig {
            enabled: true,
            base_url: None,
            token: Some("secret".to_string()),
            libraries: vec![],
        })
        .expect_err("missing base url");

        assert_eq!(error.to_string(), "plex connector requires a base_url");
    }

    #[test]
    fn enabled_plex_connector_requires_token() {
        let error = PlexConnector::init(PlexConfig {
            enabled: true,
            base_url: Some("http://127.0.0.1:32400".to_string()),
            token: None,
            libraries: vec![],
        })
        .expect_err("missing token");

        assert_eq!(error.to_string(), "plex connector requires a token");
    }

    #[tokio::test]
    async fn plex_connector_run_filters_configured_libraries() {
        async fn library_sections() -> Json<serde_json::Value> {
            Json(json!({
                "MediaContainer": {
                    "Directory": [
                        { "key": "1", "title": "Movies", "type": "movie", "Location": [{ "path": "/media/movies" }] },
                        { "key": "2", "title": "Shows", "type": "show", "Location": [{ "path": "/media/shows" }] }
                    ]
                }
            }))
        }

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let addr = listener.local_addr().expect("addr");
        let app = Router::new().route("/library/sections/all", get(library_sections));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve");
        });

        let connector = PlexConnector::init(PlexConfig {
            enabled: true,
            base_url: Some(format!("http://{addr}")),
            token: Some("secret".to_string()),
            libraries: vec!["Movies".to_string()],
        })
        .expect("connector");

        let facts = connector.run().await.expect("run");

        assert!(facts.iter().any(|fact| {
            fact.field.as_str() == "plex:title" && fact.value == Value::text("Movies")
        }));
        assert!(!facts.iter().any(|fact| {
            fact.field.as_str() == "plex:title" && fact.value == Value::text("Shows")
        }));

        server.abort();
    }

    #[tokio::test]
    #[ignore = "requires a real Plex server"]
    async fn plex_connector_live_server_smoke_long() {
        let _ = dotenvy::dotenv();
        let base_url =
            std::env::var("PONEGLYPH_PLEX_BASE_URL").expect("PONEGLYPH_PLEX_BASE_URL is set");
        let token = std::env::var("PONEGLYPH_PLEX_TOKEN").expect("PONEGLYPH_PLEX_TOKEN is set");

        let connector = PlexConnector::init(PlexConfig {
            enabled: true,
            base_url: Some(base_url),
            token: Some(token),
            libraries: vec![
                "Movies".to_string(),
                "Anime".to_string(),
                "Series".to_string(),
            ],
        })
        .expect("connector");

        let facts = connector.run().await.expect("facts");
        assert!(facts.iter().any(|fact| {
            fact.field.as_str() == "plex:title" && fact.value == Value::text("Movies")
        }));
        assert!(facts.iter().any(|fact| {
            fact.field.as_str() == "plex:title" && fact.value == Value::text("Anime")
        }));
        assert!(facts.iter().any(|fact| {
            fact.field.as_str() == "plex:title" && fact.value == Value::text("Series")
        }));
    }

    #[tokio::test]
    async fn plex_client_contract_fetch_is_exercised_through_run() {
        #[derive(Debug, Default, Clone, PartialEq, Eq)]
        struct RecordedRequest {
            token: Option<String>,
            accept: Option<String>,
        }

        #[derive(Debug, Default, Clone)]
        struct AppState {
            request: Arc<Mutex<Option<RecordedRequest>>>,
        }

        async fn library_sections(
            State(state): State<AppState>,
            Query(query): Query<std::collections::HashMap<String, String>>,
            headers: AxumHeaderMap,
        ) -> Json<serde_json::Value> {
            let token = query.get("X-Plex-Token").cloned();
            let accept = headers
                .get(ACCEPT)
                .and_then(|value| value.to_str().ok())
                .map(ToString::to_string);
            *state.request.lock().await = Some(RecordedRequest { token, accept });

            Json(json!({
                "MediaContainer": {
                    "Directory": [
                        { "key": "1", "title": "Movies", "type": "movie", "Location": [{ "path": "/media/movies" }] },
                        { "key": "2", "title": "Shows", "type": "show", "Location": [{ "path": "/media/shows" }] }
                    ]
                }
            }))
        }

        let state = AppState::default();
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let addr = listener.local_addr().expect("addr");
        let app = Router::new()
            .route("/library/sections/all", get(library_sections))
            .with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve");
        });

        let connector = PlexConnector::init(PlexConfig {
            enabled: true,
            base_url: Some(format!("http://{addr}")),
            token: Some("secret".to_string()),
            libraries: vec![],
        })
        .expect("connector");

        let facts = connector.run().await.expect("facts");
        assert!(!facts.is_empty());

        let recorded = state
            .request
            .lock()
            .await
            .clone()
            .expect("recorded request");
        assert_eq!(recorded.token.as_deref(), Some("secret"));
        assert_eq!(recorded.accept.as_deref(), Some("application/json"));

        server.abort();
    }
}
