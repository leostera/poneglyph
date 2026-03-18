use derive_builder::Builder;
use poneglyph::Fact;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tracing::info;

use crate::{CtlError, CtlResult, CtlStore, GoogleCalendarResource, GoogleOAuthConnection};

use super::client::GcalClient;
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

    pub async fn run(self, _fact_tx: mpsc::Sender<Vec<Fact>>) -> CtlResult<()> {
        if !self.config.enabled {
            info!("gcal connector disabled, skipping");
            return Ok(());
        }

        info!(
            enabled = self.config.enabled,
            "gcal connector scaffold initialized"
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
    use super::{GcalConfig, GcalConnector};

    #[test]
    fn gcal_connector_initializes_with_valid_config() {
        let connector = GcalConnector::init(GcalConfig { enabled: true }).expect("connector");

        assert_eq!(connector.name(), "gcal");
        assert_eq!(connector.schema_namespace(), "gcal");
    }
}
