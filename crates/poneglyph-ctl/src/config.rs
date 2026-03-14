use derive_builder::Builder;
use serde::{Deserialize, Serialize};

use crate::connectors::plex::PlexConfig;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, Builder)]
#[builder(pattern = "owned")]
pub struct PoneglyphCtlConfig {
    #[serde(default)]
    #[builder(default)]
    pub plex: Option<PlexConfig>,
}

#[cfg(test)]
mod tests {
    use super::PoneglyphCtlConfig;
    use crate::PlexConfig;

    #[test]
    fn ctl_config_defaults_to_no_connectors() {
        assert_eq!(PoneglyphCtlConfig::default().plex, None);
    }

    #[test]
    fn plex_connector_config_round_trips_through_toml() {
        let config = PoneglyphCtlConfig {
            plex: Some(PlexConfig {
                enabled: true,
                base_url: Some("http://127.0.0.1:32400".to_string()),
                token: Some("secret".to_string()),
                libraries: vec!["Movies".to_string(), "Shows".to_string()],
            }),
        };

        let toml = toml::to_string(&config).expect("serialize");
        let decoded: PoneglyphCtlConfig = toml::from_str(&toml).expect("deserialize");
        assert_eq!(decoded, config);
    }
}
