use derive_builder::Builder;
use poneglyph::Fact;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::time::{Duration, sleep};
use tracing::{debug, info, warn};

use crate::{CtlError, CtlResult, CtlStore};

use super::client::PlexClient;
use super::ingestor::{item_facts, library_facts, section_snapshot_fingerprint, select_sections};
use super::schema::schema_facts;
use super::types::{PlexLibrarySection, PlexMetadataItem};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, Builder)]
#[builder(pattern = "owned")]
pub struct PlexConfig {
    #[serde(default)]
    #[builder(default)]
    pub enabled: bool,
}

#[derive(Debug)]
pub struct PlexConnector {
    config: PlexConfig,
}

impl PlexConnector {
    pub fn init(config: PlexConfig) -> CtlResult<Self> {
        Ok(Self { config })
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

    pub fn schema_facts(&self) -> Vec<Fact> {
        schema_facts()
    }

    pub async fn run(self, ctl: CtlStore, fact_tx: mpsc::Sender<Vec<Fact>>) -> CtlResult<()> {
        let mut facts = Vec::new();
        let connections = ctl
            .list_plex_connections()
            .await?
            .into_iter()
            .map(|connection| PlexRunConnection {
                scope: format!("store-{}", connection.id),
                base_url: connection.base_url,
                token: connection.token,
                libraries: connection.libraries,
            })
            .collect::<Vec<_>>();

        if connections.is_empty() {
            info!("plex connector has no configured servers");
            return Ok(());
        }

        sleep(Duration::from_millis(10)).await;

        for connection in connections {
            let client = PlexClient::new(&connection.base_url, &connection.token)?;
            let sections = client.fetch_library_sections().await?;
            let selected_sections = select_sections(&connection.libraries, sections);
            let libraries_url = client.redacted_library_sections_url()?;
            let base_url = client.base_url().to_string();
            info!(
                scope = %connection.scope,
                base_url = %base_url,
                libraries_url = %libraries_url,
                configured_library_count = connection.libraries.len(),
                selected_library_count = selected_sections.len(),
                "plex connector initialized"
            );

            if !connection.libraries.is_empty() {
                debug!(
                    scope = %connection.scope,
                    libraries = ?connection.libraries,
                    "plex connector configured libraries"
                );
            }
            if selected_sections.is_empty() {
                warn!(scope = %connection.scope, "plex connector selected no libraries");
            } else {
                let library_titles = selected_sections
                    .iter()
                    .map(|section| section.title.as_str())
                    .collect::<Vec<_>>();
                info!(
                    scope = %connection.scope,
                    libraries = ?library_titles,
                    "plex connector selected libraries"
                );
            }

            for section in &selected_sections {
                let items = match client.fetch_library_items(section.key.as_str()).await {
                    Ok(items) => items,
                    Err(error) => {
                        let state_key = format!("{}:{}", connection.scope, section.key);
                        let _ = ctl
                            .save_plex_library_sync_failure(state_key.as_str(), &error.to_string())
                            .await;
                        return Err(error);
                    }
                };
                let fingerprint = section_snapshot_fingerprint(section, &items);
                let state_key = format!("{}:{}", connection.scope, section.key);
                let previous = ctl
                    .plex_library_sync_state(state_key.as_str())
                    .await?
                    .and_then(|state| state.content_fingerprint);
                if previous.as_deref() == Some(fingerprint.as_str()) {
                    debug!(
                        scope = %connection.scope,
                        library = %section.title,
                        section_key = %section.key,
                        "plex connector skipped unchanged library"
                    );
                    ctl.save_plex_library_sync_success(state_key.as_str(), &fingerprint)
                        .await?;
                    continue;
                }

                let scoped_section = scoped_section(section, connection.scope.as_str());
                let scoped_items = items
                    .iter()
                    .map(|item| scoped_item(item, connection.scope.as_str()))
                    .collect::<Vec<_>>();
                debug!(
                    scope = %connection.scope,
                    library = %section.title,
                    section_key = %section.key,
                    item_count = items.len(),
                    "plex connector fetched library items"
                );
                facts.extend(library_facts(std::slice::from_ref(&scoped_section)));
                facts.extend(item_facts(&scoped_section, &scoped_items));
                ctl.save_plex_library_sync_success(state_key.as_str(), &fingerprint)
                    .await?;
            }
        }

        if facts.is_empty() {
            info!("plex connector found no changed libraries to sync");
            return Ok(());
        }

        info!(
            fact_count = facts.len(),
            "plex connector emitting fact batch"
        );
        fact_tx
            .send(facts)
            .await
            .map_err(|error| CtlError::PlexRequest(error.to_string()))?;
        debug!("plex connector fact batch sent");
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct PlexRunConnection {
    scope: String,
    base_url: String,
    token: String,
    libraries: Vec<String>,
}

fn scoped_section(section: &PlexLibrarySection, scope: &str) -> PlexLibrarySection {
    let mut scoped = section.clone();
    scoped.key = format!("{scope}:{}", section.key);
    scoped
}

fn scoped_item(item: &PlexMetadataItem, scope: &str) -> PlexMetadataItem {
    let mut scoped = item.clone();
    scoped.rating_key = format!("{scope}:{}", item.rating_key);
    scoped
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
    use poneglyph::{Fact, Value};
    use reqwest::header::ACCEPT;
    use serde_json::json;
    use tokio::{
        net::TcpListener,
        sync::{Mutex, mpsc},
    };

    use crate::{CtlStore, SavePlexConnection};

    use super::{PlexConfig, PlexConnector};

    #[test]
    fn plex_connector_initializes_with_valid_config() {
        let connector = PlexConnector::init(PlexConfig { enabled: true }).expect("connector");

        assert_eq!(connector.name(), "plex");
        assert_eq!(connector.schema_namespace(), "plex");
    }

    async fn save_test_plex_connection(
        ctl: &CtlStore,
        name: &str,
        machine_identifier: &str,
        base_url: &str,
        token: &str,
        libraries: Vec<String>,
    ) {
        ctl.save_plex_connection(SavePlexConnection {
            name: name.to_string(),
            machine_identifier: machine_identifier.to_string(),
            base_url: base_url.to_string(),
            token: token.to_string(),
            libraries,
        })
        .await
        .expect("save plex connection");
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

        async fn library_items() -> Json<serde_json::Value> {
            Json(json!({
                "MediaContainer": {
                    "Metadata": [
                        {
                            "ratingKey": "101",
                            "key": "/library/metadata/101",
                            "guid": "plex://movie/abc",
                            "type": "movie",
                            "title": "Dune",
                            "summary": "Spice.",
                            "year": 2021,
                            "addedAt": 1710000000,
                            "updatedAt": 1710000100
                        }
                    ]
                }
            }))
        }

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let addr = listener.local_addr().expect("addr");
        let app = Router::new()
            .route("/library/sections/all", get(library_sections))
            .route("/library/sections/1/all", get(library_items));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve");
        });

        let connector = PlexConnector::init(PlexConfig { enabled: true }).expect("connector");
        let tempdir = tempfile::tempdir().expect("tempdir");
        let ctl = CtlStore::open(tempdir.path().join("control.db"))
            .await
            .expect("ctl");
        let base_url = format!("http://{addr}");
        save_test_plex_connection(
            &ctl,
            "Local Plex",
            "machine-1",
            &base_url,
            "secret",
            vec!["Movies".to_string()],
        )
        .await;

        let (fact_tx, mut fact_stream) = mpsc::channel(1);
        connector.run(ctl, fact_tx).await.expect("run");
        let facts: Vec<Fact> = fact_stream.recv().await.expect("facts");

        assert!(facts.iter().any(|fact| {
            fact.field.as_str() == "plex:title" && fact.value == Value::text("Movies")
        }));
        assert!(facts.iter().any(|fact| {
            fact.field.as_str() == "plex:title" && fact.value == Value::text("Dune")
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

        let connector = PlexConnector::init(PlexConfig { enabled: true }).expect("connector");
        let tempdir = tempfile::tempdir().expect("tempdir");
        let ctl = CtlStore::open(tempdir.path().join("control.db"))
            .await
            .expect("ctl");
        save_test_plex_connection(
            &ctl,
            "Local Plex",
            "machine-live",
            &base_url,
            &token,
            vec![
                "Movies".to_string(),
                "Anime".to_string(),
                "Series".to_string(),
            ],
        )
        .await;

        let (fact_tx, mut fact_stream) = mpsc::channel(1);
        connector.run(ctl, fact_tx).await.expect("run");
        let facts: Vec<Fact> = fact_stream.recv().await.expect("facts");
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

        async fn library_items() -> Json<serde_json::Value> {
            Json(json!({
                "MediaContainer": {
                    "Metadata": [
                        {
                            "ratingKey": "101",
                            "type": "movie",
                            "title": "Dune"
                        }
                    ]
                }
            }))
        }

        let state = AppState::default();
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let addr = listener.local_addr().expect("addr");
        let app = Router::new()
            .route("/library/sections/all", get(library_sections))
            .route("/library/sections/1/all", get(library_items))
            .route("/library/sections/2/all", get(library_items))
            .with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve");
        });

        let connector = PlexConnector::init(PlexConfig { enabled: true }).expect("connector");
        let tempdir = tempfile::tempdir().expect("tempdir");
        let ctl = CtlStore::open(tempdir.path().join("control.db"))
            .await
            .expect("ctl");
        let base_url = format!("http://{addr}");
        save_test_plex_connection(&ctl, "Local Plex", "machine-2", &base_url, "secret", vec![])
            .await;

        let (fact_tx, mut fact_stream) = mpsc::channel(1);
        connector.run(ctl, fact_tx).await.expect("run");
        let facts: Vec<Fact> = fact_stream.recv().await.expect("facts");
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

    #[tokio::test]
    async fn plex_connector_skips_unchanged_libraries_on_subsequent_runs() {
        async fn library_sections() -> Json<serde_json::Value> {
            Json(json!({
                "MediaContainer": {
                    "Directory": [
                        { "key": "1", "title": "Movies", "type": "movie", "Location": [{ "path": "/media/movies" }] }
                    ]
                }
            }))
        }

        async fn library_items() -> Json<serde_json::Value> {
            Json(json!({
                "MediaContainer": {
                    "Metadata": [
                        {
                            "ratingKey": "101",
                            "key": "/library/metadata/101",
                            "guid": "plex://movie/abc",
                            "type": "movie",
                            "title": "Dune",
                            "summary": "Spice.",
                            "year": 2021,
                            "addedAt": 1710000000,
                            "updatedAt": 1710000100
                        }
                    ]
                }
            }))
        }

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let addr = listener.local_addr().expect("addr");
        let app = Router::new()
            .route("/library/sections/all", get(library_sections))
            .route("/library/sections/1/all", get(library_items));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve");
        });

        let tempdir = tempfile::tempdir().expect("tempdir");
        let ctl = CtlStore::open(tempdir.path().join("control.db"))
            .await
            .expect("ctl");

        let connector = PlexConnector::init(PlexConfig { enabled: true }).expect("connector");
        let base_url = format!("http://{addr}");
        save_test_plex_connection(
            &ctl,
            "Local Plex",
            "machine-3",
            &base_url,
            "secret",
            vec!["Movies".to_string()],
        )
        .await;
        let (fact_tx, mut fact_stream) = mpsc::channel(1);
        connector
            .run(ctl.clone(), fact_tx)
            .await
            .expect("first run");
        assert!(fact_stream.recv().await.is_some());

        let connector = PlexConnector::init(PlexConfig { enabled: true }).expect("connector");
        let (fact_tx, mut fact_stream) = mpsc::channel(1);
        connector
            .run(ctl.clone(), fact_tx)
            .await
            .expect("second run");
        assert!(fact_stream.recv().await.is_none());

        let sync_state = ctl
            .plex_library_sync_state("store-1:1")
            .await
            .expect("sync state")
            .expect("saved sync state");
        assert!(sync_state.content_fingerprint.is_some());
        assert!(sync_state.last_synced_at.is_some());

        server.abort();
    }
}
