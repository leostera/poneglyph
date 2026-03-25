use std::sync::Arc;

use derive_builder::Builder;
use poneglyph::{Fact, Poneglyph};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::time::{Duration, sleep};
use tracing::{debug, info, warn};

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
    #[serde(default = "default_poll_interval_seconds")]
    #[builder(default = "default_poll_interval_seconds()")]
    pub poll_interval_seconds: u64,
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
        let client = GmailClient::default();
        let ingestor = GmailIngestor::new(poneglyph);
        let poll_interval = Duration::from_secs(self.config.poll_interval_seconds);
        info!(
            poll_interval_seconds = self.config.poll_interval_seconds,
            max_messages = self.config.max_messages,
            "gmail connector started continuous sync poller"
        );

        loop {
            let connections = store.list_google_oauth_connections().await?;
            if connections.is_empty() {
                debug!("gmail connector has no saved google oauth connections");
                sleep(poll_interval).await;
                continue;
            }

            for connection in connections {
                match self
                    .ingest_connection(&client, &ingestor, &store, &connection)
                    .await
                {
                    Ok(None) => {
                        debug!(
                            connection_id = connection.id,
                            "gmail connector detected no new mailbox changes"
                        );
                    }
                    Ok(Some(connection_facts)) => {
                        let fact_count = connection_facts.len();
                        if fact_count == 0 {
                            continue;
                        }
                        fact_tx
                            .send(connection_facts)
                            .await
                            .map_err(|error| crate::CtlError::GmailRequest(error.to_string()))?;
                        info!(
                            connection_id = connection.id,
                            fact_count, "gmail connector emitted incremental fact batch"
                        );
                    }
                    Err(error) => {
                        warn!(
                            connection_id = connection.id,
                            %error,
                            "gmail connector skipped oauth connection due to sync error"
                        );
                        let _ = store
                            .save_gmail_sync_failure(connection.id, &error.to_string())
                            .await;
                    }
                }
            }

            sleep(poll_interval).await;
        }
    }

    pub async fn sync_connection_once(
        &self,
        store: &CtlStore,
        poneglyph: Arc<Poneglyph>,
        connection_id: i64,
    ) -> CtlResult<usize> {
        let connection = store
            .google_oauth_connection_by_id(connection_id)
            .await?
            .ok_or_else(|| {
                crate::CtlError::GmailRequest("google oauth connection not found".into())
            })?;
        let client = GmailClient::default();
        let ingestor = GmailIngestor::new(poneglyph.clone());

        match self
            .ingest_connection(&client, &ingestor, store, &connection)
            .await
        {
            Ok(Some(facts)) => {
                let fact_count = facts.len();
                if fact_count > 0 {
                    poneglyph
                        .state_facts(facts)
                        .await
                        .map_err(|error| crate::CtlError::GmailRequest(error.to_string()))?;
                }
                Ok(fact_count)
            }
            Ok(None) => Ok(0),
            Err(error) => {
                let _ = store
                    .save_gmail_sync_failure(connection.id, &error.to_string())
                    .await;
                Err(error)
            }
        }
    }

    async fn ingest_connection(
        &self,
        client: &GmailClient,
        ingestor: &GmailIngestor,
        store: &CtlStore,
        connection: &GoogleOAuthConnection,
    ) -> CtlResult<Option<Vec<Fact>>> {
        let profile = client.profile(&connection.access_token).await?;
        store
            .set_google_oauth_connection_account_email(connection.id, &profile.email_address)
            .await?;
        let send_as_addresses = match client
            .list_send_as_addresses(&connection.access_token)
            .await
        {
            Ok(addresses) => addresses,
            Err(error) => {
                warn!(
                    connection_id = connection.id,
                    %error,
                    "gmail connector could not list send-as addresses"
                );
                Vec::new()
            }
        };
        let saved_history_id = store
            .gmail_sync_state(connection.id)
            .await?
            .and_then(|state| state.last_history_id);
        if saved_history_id.is_some() && saved_history_id == profile.history_id {
            store
                .save_gmail_sync_success(connection.id, profile.history_id.as_deref())
                .await?;
            return Ok(None);
        }

        let labels = client.list_labels(&connection.access_token).await?;
        let messages = client
            .list_messages(&connection.access_token, self.config.max_messages)
            .await?;
        let facts = ingestor
            .ingest_account_snapshot(&profile, &send_as_addresses, &labels, &messages)
            .await?;
        store
            .save_gmail_sync_success(connection.id, profile.history_id.as_deref())
            .await?;
        Ok(Some(facts))
    }
}

const fn default_max_messages() -> usize {
    200
}

const fn default_poll_interval_seconds() -> u64 {
    30
}
