use std::sync::Arc;

use derive_builder::Builder;
use poneglyph::{Fact, Poneglyph};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::{CtlResult, CtlStore, GoogleOAuthConnection};

use super::{client::GmailClient, ingestor::GmailIngestor, schema::GmailSchema};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, Builder)]
#[builder(pattern = "owned")]
pub struct GmailConfig {
    #[serde(default)]
    #[builder(default)]
    pub enabled: bool,
    #[serde(default = "default_max_messages")]
    #[builder(default = "default_max_messages()")]
    pub max_messages: usize,
}

#[derive(Debug, Clone)]
pub struct GmailConnector {
    config: GmailConfig,
}

impl GmailConnector {
    pub fn init(config: GmailConfig) -> CtlResult<Self> {
        Ok(Self { config })
    }

    pub fn name(&self) -> &'static str {
        "gmail"
    }

    pub fn config(&self) -> &GmailConfig {
        &self.config
    }

    pub fn schema_namespace(&self) -> &'static str {
        "gmail"
    }

    pub fn schema_facts(&self) -> Vec<Fact> {
        GmailSchema::facts()
    }

    pub async fn run(
        self,
        store: CtlStore,
        poneglyph: Arc<Poneglyph>,
        fact_tx: mpsc::Sender<Vec<Fact>>,
    ) -> CtlResult<()> {
        if !self.config.enabled {
            info!("gmail connector disabled, skipping");
            return Ok(());
        }

        let connections = store.list_google_oauth_connections().await?;
        if connections.is_empty() {
            info!("gmail connector has no saved google oauth connections");
            return Ok(());
        }

        let client = GmailClient::default();
        let ingestor = GmailIngestor::new(poneglyph);
        let mut facts = Vec::new();

        for connection in connections {
            match self
                .ingest_connection(&client, &ingestor, &connection)
                .await
            {
                Ok(connection_facts) => {
                    facts.extend(connection_facts);
                }
                Err(error) => {
                    warn!(
                        connection_id = connection.id,
                        %error,
                        "gmail connector skipped oauth connection due to sync error"
                    );
                }
            }
        }

        if facts.is_empty() {
            info!("gmail connector produced no facts");
            return Ok(());
        }

        let fact_count = facts.len();
        fact_tx
            .send(facts)
            .await
            .map_err(|error| crate::CtlError::GmailRequest(error.to_string()))?;
        info!(fact_count, "gmail connector emitted fact batch");
        Ok(())
    }

    async fn ingest_connection(
        &self,
        client: &GmailClient,
        ingestor: &GmailIngestor,
        connection: &GoogleOAuthConnection,
    ) -> CtlResult<Vec<Fact>> {
        let profile = client.profile(&connection.access_token).await?;
        let labels = client.list_labels(&connection.access_token).await?;
        let messages = client
            .list_messages(&connection.access_token, self.config.max_messages)
            .await?;
        ingestor
            .ingest_account_snapshot(&profile, &labels, &messages)
            .await
    }
}

const fn default_max_messages() -> usize {
    200
}
