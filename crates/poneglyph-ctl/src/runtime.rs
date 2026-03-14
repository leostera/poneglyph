use std::sync::Arc;

use derive_builder::Builder;
use poneglyph::{Poneglyph, uri};
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tracing::{debug, info, instrument, warn};

use crate::{CtlError, CtlResult, PlexConnector};

#[derive(Debug)]
enum ConnectorProcess {
    Plex(PlexConnector),
}

#[derive(Builder)]
#[builder(pattern = "owned")]
pub struct ConnectorRuntime {
    poneglyph: Arc<Poneglyph>,
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
        for connector in &self.connectors {
            ensure_connector_schema(&poneglyph, connector).await?;
        }
        let (fact_tx, mut fact_rx) = mpsc::channel::<Vec<poneglyph::Fact>>(32);
        let mut tasks = JoinSet::new();
        let connector_count = self.connectors.len();

        for connector in self.connectors {
            match connector {
                ConnectorProcess::Plex(connector) => {
                    debug!(connector = connector.name(), "running connector");
                    let fact_tx = fact_tx.clone();
                    tasks.spawn(async move { connector.run(fact_tx).await });
                }
            }
        }
        if connector_count == 0 {
            warn!("connector runtime started with no connectors configured");
        } else {
            info!(
                connector_count,
                "connector runtime started connector producers"
            );
        }
        drop(fact_tx);

        let bridge_poneglyph = poneglyph.clone();
        tasks.spawn(async move {
            while let Some(facts) = fact_rx.recv().await {
                let fact_count = facts.len();
                debug!(fact_count, "connector runtime received fact batch");
                bridge_poneglyph
                    .state_facts(facts)
                    .await
                    .map(|tx_id| {
                        info!(%tx_id, fact_count, "connector runtime stated fact batch");
                    })
                    .map_err(|error| CtlError::PlexRequest(error.to_string()))?;
            }
            debug!("connector runtime fact bridge drained");
            Ok(())
        });

        let _ = tasks
            .join_all()
            .await
            .into_iter()
            .collect::<Result<Vec<()>, _>>()?;

        info!("connector runtime stopped");
        Ok(())
    }
}

async fn ensure_connector_schema(
    poneglyph: &Arc<Poneglyph>,
    connector: &ConnectorProcess,
) -> CtlResult<()> {
    match connector {
        ConnectorProcess::Plex(connector) => {
            let schema = poneglyph
                .get_schema()
                .await
                .map_err(|error| CtlError::PlexRequest(error.to_string()))?;
            let namespace_uri = uri!("plex:namespace");
            if schema
                .namespaces
                .iter()
                .any(|namespace| namespace.uri == namespace_uri)
            {
                debug!(
                    connector = connector.name(),
                    "connector schema already present"
                );
                return Ok(());
            }

            let schema_facts = connector.schema_facts();
            let fact_count = schema_facts.len();
            let tx_id = poneglyph
                .state_facts(schema_facts)
                .await
                .map_err(|error| CtlError::PlexRequest(error.to_string()))?;
            info!(
                connector = connector.name(),
                %tx_id,
                fact_count,
                "connector schema bootstrapped"
            );
            Ok(())
        }
    }
}

impl ConnectorRuntimeBuilder {
    pub fn with_poneglyph(mut self, poneglyph: Poneglyph) -> Self {
        self.poneglyph = Some(Arc::new(poneglyph));
        self
    }

    pub fn with_poneglyph_arc(mut self, poneglyph: Arc<Poneglyph>) -> Self {
        self.poneglyph = Some(poneglyph);
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

    async fn test_poneglyph() -> Arc<Poneglyph> {
        let tempdir = tempdir().expect("tempdir");
        Arc::new(
            Poneglyph::builder()
                .with_workspace(Workspace::at(tempdir.path()))
                .build()
                .await
                .expect("poneglyph"),
        )
    }

    #[tokio::test]
    async fn runtime_runs_without_connectors() {
        let poneglyph = test_poneglyph().await;

        ConnectorRuntime::builder()
            .with_poneglyph_arc(poneglyph)
            .build()
            .expect("runtime")
            .run()
            .await
            .expect("run");
    }

    #[tokio::test]
    async fn runtime_runs_disabled_plex_connector() {
        let poneglyph = test_poneglyph().await;
        let plex = PlexConnector::init(PlexConfig::default()).expect("plex");

        ConnectorRuntime::builder()
            .with_poneglyph_arc(poneglyph)
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
        let app = app.route(
            "/library/sections/5/all",
            axum::routing::get(|| async {
                axum::Json(serde_json::json!({
                    "MediaContainer": {
                        "Metadata": [
                            {
                                "ratingKey": "101",
                                "key": "/library/metadata/101",
                                "guid": "plex://movie/dune",
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
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve");
        });

        let poneglyph = test_poneglyph().await;
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

        let item_result: QueryResult = poneglyph
            .query(Query::parse("'plex:title'(Item, \"Dune\")").expect("query"))
            .await
            .expect("result");
        assert_eq!(item_result.len(), 1);

        server.abort();
    }
}
