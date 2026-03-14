use std::sync::Arc;

use derive_builder::Builder;
use poneglyph::Poneglyph;
use tokio::sync::mpsc;
use tracing::{debug, info, instrument};

use crate::{CtlError, CtlResult, PlexConnector};

#[derive(Debug, Clone)]
enum ConnectorProcess {
    Plex(PlexConnector),
}

#[derive(Default, Builder)]
#[builder(pattern = "owned")]
pub struct ConnectorRuntime {
    #[builder(default)]
    poneglyph: Option<Arc<Poneglyph>>,
    #[builder(default)]
    connectors: Vec<ConnectorProcess>,
}

impl ConnectorRuntime {
    pub fn builder() -> ConnectorRuntimeBuilder {
        ConnectorRuntimeBuilder::default()
    }

    #[instrument(skip(self), fields(component = "poneglyph-ctl", connector_count = self.connectors.len()))]
    pub async fn run(self) -> CtlResult<()> {
        info!("connector runtime starting");
        let poneglyph = self.poneglyph;

        for connector in self.connectors {
            match connector {
                ConnectorProcess::Plex(connector) => {
                    debug!(connector = connector.name(), "running connector");
                    let facts = connector.run().await?;
                    if facts.is_empty() {
                        continue;
                    }

                    let poneglyph = poneglyph
                        .as_ref()
                        .ok_or(CtlError::MissingPoneglyphRuntime)?
                        .clone();
                    let (tx, rx) = mpsc::channel(facts.len().max(1));
                    tokio::spawn(async move {
                        for fact in facts {
                            if tx.send(fact).await.is_err() {
                                break;
                            }
                        }
                    });
                    poneglyph
                        .state_facts(rx)
                        .await
                        .map_err(|error| CtlError::PlexRequest(error.to_string()))?;
                }
            }
        }

        info!("connector runtime stopped");
        Ok(())
    }
}

impl ConnectorRuntimeBuilder {
    pub fn with_poneglyph(mut self, poneglyph: Poneglyph) -> Self {
        self.poneglyph = Some(Some(Arc::new(poneglyph)));
        self
    }

    pub fn with_poneglyph_arc(mut self, poneglyph: Arc<Poneglyph>) -> Self {
        self.poneglyph = Some(Some(poneglyph));
        self
    }

    pub fn add_connector(mut self, connector: PlexConnector) -> Self {
        self.connectors
            .get_or_insert_with(Vec::new)
            .push(ConnectorProcess::Plex(connector));
        self
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tempfile::tempdir;

    use crate::{ConnectorRuntime, PlexConfig, PlexConnector};
    use poneglyph::{Poneglyph, Query, QueryResult, Workspace};

    #[tokio::test]
    async fn runtime_runs_without_connectors() {
        ConnectorRuntime::builder()
            .build()
            .expect("runtime")
            .run()
            .await
            .expect("run");
    }

    #[tokio::test]
    async fn runtime_runs_disabled_plex_connector() {
        let plex = PlexConnector::init(PlexConfig::default()).expect("plex");

        ConnectorRuntime::builder()
            .add_connector(plex)
            .build()
            .expect("runtime")
            .run()
            .await
            .expect("run");
    }

    #[tokio::test]
    async fn runtime_ingests_connector_facts_into_poneglyph() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let addr = listener.local_addr().expect("addr");
        let app = axum::Router::new().route(
            "/library/sections/all",
            axum::routing::get(|| async {
                axum::Json(serde_json::json!({
                    "MediaContainer": {
                        "Directory": [
                            {
                                "key": "5",
                                "title": "Movies",
                                "type": "movie",
                                "Location": [{ "path": "/media/movies" }]
                            }
                        ]
                    }
                }))
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve");
        });

        let tempdir = tempdir().expect("tempdir");
        let poneglyph = Arc::new(
            Poneglyph::builder()
                .with_workspace(Workspace::at(tempdir.path()))
                .build()
                .await
                .expect("poneglyph"),
        );
        let plex = PlexConnector::init(PlexConfig {
            enabled: true,
            base_url: Some(format!("http://{addr}")),
            token: Some("secret".to_string()),
            libraries: vec!["Movies".to_string()],
        })
        .expect("plex");

        ConnectorRuntime::builder()
            .with_poneglyph_arc(poneglyph.clone())
            .add_connector(plex)
            .build()
            .expect("runtime")
            .run()
            .await
            .expect("run");

        let result: QueryResult = poneglyph
            .query(Query::parse("'plex:title'(Library, \"Movies\")").expect("query"))
            .await
            .expect("result");
        assert_eq!(result.len(), 1);

        server.abort();
    }
}
