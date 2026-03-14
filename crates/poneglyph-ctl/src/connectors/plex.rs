use std::collections::BTreeSet;

use derive_builder::Builder;
use reqwest::header::{ACCEPT, HeaderMap, HeaderValue};
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use tokio::time::{Duration, sleep};
use tracing::{debug, info, instrument};

use crate::{CtlError, CtlResult};

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
    pub async fn run(self) -> CtlResult<()> {
        if !self.config.enabled {
            info!("plex connector disabled, skipping");
            return Ok(());
        }

        let sections = self.client.fetch_library_sections().await?;
        let configured_libraries: BTreeSet<&str> =
            self.config.libraries.iter().map(String::as_str).collect();
        let selected_sections: Vec<&PlexLibrarySection> = if configured_libraries.is_empty() {
            sections.iter().collect()
        } else {
            sections
                .iter()
                .filter(|section| configured_libraries.contains(section.title.as_str()))
                .collect()
        };
        let libraries_url = self.client.library_sections_url()?;
        let base_url = self
            .client
            .base_url()
            .map(ToString::to_string)
            .unwrap_or_else(|| "<missing>".to_string());
        info!(
            base_url = %base_url,
            libraries_url = %libraries_url,
            discovered_library_count = sections.len(),
            selected_library_count = selected_sections.len(),
            "plex connector initialized"
        );

        if !self.config.libraries.is_empty() {
            debug!(libraries = ?self.config.libraries, "plex connector configured libraries");
        }

        let _http = &self.client.http;
        sleep(Duration::from_millis(10)).await;
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct PlexClient {
    base_url: Option<Url>,
    token: Option<String>,
    http: Client,
}

impl PlexClient {
    fn new(config: &PlexConfig) -> CtlResult<Self> {
        let base_url = match &config.base_url {
            Some(base_url) => Some(
                Url::parse(base_url)
                    .map_err(|_| CtlError::InvalidPlexBaseUrl(base_url.to_string()))?,
            ),
            None => None,
        };

        if config.enabled && config.token.is_none() {
            return Err(CtlError::MissingPlexToken);
        }

        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        let http = Client::builder()
            .default_headers(headers)
            .build()
            .map_err(|_| {
                CtlError::InvalidPlexBaseUrl(
                    base_url
                        .as_ref()
                        .map(Url::to_string)
                        .unwrap_or_else(|| "missing".to_string()),
                )
            })?;

        Ok(Self {
            base_url,
            token: config.token.clone(),
            http,
        })
    }

    fn base_url(&self) -> Option<&Url> {
        self.base_url.as_ref()
    }

    fn library_sections_url(&self) -> CtlResult<Url> {
        let mut url = self.base_url.clone().ok_or(CtlError::MissingPlexBaseUrl)?;
        url.set_path("/library/sections/all");
        if let Some(token) = &self.token {
            url.query_pairs_mut().append_pair("X-Plex-Token", token);
        }
        Ok(url)
    }

    async fn fetch_library_sections(&self) -> CtlResult<Vec<PlexLibrarySection>> {
        let url = self.library_sections_url()?;
        let response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|error| CtlError::PlexRequest(error.to_string()))?;

        if response.status() != StatusCode::OK {
            return Err(CtlError::PlexUnexpectedStatus(response.status().as_u16()));
        }

        let payload: PlexMediaContainer = response
            .json()
            .await
            .map_err(|error| CtlError::PlexResponseDecode(error.to_string()))?;
        Ok(payload.media_container.directory.unwrap_or_default())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
struct PlexMediaContainer {
    #[serde(rename = "MediaContainer")]
    media_container: PlexLibrarySections,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
struct PlexLibrarySections {
    #[serde(rename = "Directory")]
    directory: Option<Vec<PlexLibrarySection>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
struct PlexLibrarySection {
    key: String,
    title: String,
    #[serde(rename = "type")]
    section_type: String,
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
    use serde_json::json;
    use tokio::{net::TcpListener, sync::Mutex};

    use crate::PlexConfig;

    use super::PlexConnector;

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

    #[test]
    fn plex_connector_builds_library_sections_url() {
        let connector = PlexConnector::init(PlexConfig {
            enabled: true,
            base_url: Some("http://127.0.0.1:32400".to_string()),
            token: Some("secret".to_string()),
            libraries: vec![],
        })
        .expect("connector");

        let url = connector.client.library_sections_url().expect("url");
        assert_eq!(
            url.as_str(),
            "http://127.0.0.1:32400/library/sections/all?X-Plex-Token=secret"
        );
    }

    #[tokio::test]
    async fn plex_connector_fetches_library_sections_from_http_contract() {
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
                .get(reqwest::header::ACCEPT)
                .and_then(|value| value.to_str().ok())
                .map(ToString::to_string);
            *state.request.lock().await = Some(RecordedRequest { token, accept });

            Json(json!({
                "MediaContainer": {
                    "Directory": [
                        { "key": "1", "title": "Movies", "type": "movie" },
                        { "key": "2", "title": "Shows", "type": "show" }
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

        let sections = connector
            .client
            .fetch_library_sections()
            .await
            .expect("sections");
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].title, "Movies");
        assert_eq!(sections[1].title, "Shows");

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

    #[tokio::test]
    async fn plex_connector_run_filters_configured_libraries() {
        async fn library_sections() -> Json<serde_json::Value> {
            Json(json!({
                "MediaContainer": {
                    "Directory": [
                        { "key": "1", "title": "Movies", "type": "movie" },
                        { "key": "2", "title": "Shows", "type": "show" }
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

        connector.run().await.expect("run");

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

        let sections = connector
            .client
            .fetch_library_sections()
            .await
            .expect("sections");

        let titles: Vec<&str> = sections
            .iter()
            .map(|section| section.title.as_str())
            .collect();
        assert!(titles.contains(&"Movies"));
        assert!(titles.contains(&"Anime"));
        assert!(titles.contains(&"Series"));
    }
}
