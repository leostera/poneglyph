use derive_builder::Builder;
use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlexConnector {
    config: PlexConfig,
}

impl PlexConnector {
    pub fn init(config: PlexConfig) -> CtlResult<Self> {
        if config.enabled && config.base_url.is_none() {
            return Err(CtlError::MissingPlexBaseUrl);
        }

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
}

#[cfg(test)]
mod tests {
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
            token: None,
            libraries: vec![],
        })
        .expect_err("missing base url");

        assert_eq!(error.to_string(), "plex connector requires a base_url");
    }
}
