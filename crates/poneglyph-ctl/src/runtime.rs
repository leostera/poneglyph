use derive_builder::Builder;
use tracing::{debug, info, instrument};

use crate::{CtlResult, PlexConnector};

#[derive(Debug, Clone)]
enum ConnectorProcess {
    Plex(PlexConnector),
}

#[derive(Debug, Default, Builder)]
#[builder(pattern = "owned")]
pub struct ConnectorRuntime {
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

        for connector in self.connectors {
            match connector {
                ConnectorProcess::Plex(connector) => {
                    debug!(connector = connector.name(), "running connector");
                    connector.run().await?;
                }
            }
        }

        info!("connector runtime stopped");
        Ok(())
    }
}

impl ConnectorRuntimeBuilder {
    pub fn add_connector(mut self, connector: PlexConnector) -> Self {
        self.connectors
            .get_or_insert_with(Vec::new)
            .push(ConnectorProcess::Plex(connector));
        self
    }
}

#[cfg(test)]
mod tests {
    use crate::{ConnectorRuntime, PlexConfig, PlexConnector};

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
}
