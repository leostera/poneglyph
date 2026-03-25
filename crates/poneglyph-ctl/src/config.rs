use derive_builder::Builder;
use serde::{Deserialize, Serialize};

use crate::connectors::filesystem::FilesystemConfig;
use crate::connectors::gcal::GcalConfig;
use crate::connectors::gmail::GmailConfig;
use crate::connectors::plex::PlexConfig;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, Builder)]
#[builder(pattern = "owned")]
pub struct PoneglyphCtlConfig {
    #[serde(default)]
    #[builder(default)]
    pub filesystem: Option<FilesystemConfig>,
    #[serde(default)]
    #[builder(default)]
    pub gcal: Option<GcalConfig>,
    #[serde(default)]
    #[builder(default)]
    pub gmail: Option<GmailConfig>,
    #[serde(default)]
    #[builder(default)]
    pub plex: Option<PlexConfig>,
}

#[cfg(test)]
mod tests {
    use super::PoneglyphCtlConfig;
    use crate::{FilesystemConfig, GcalConfig, GmailConfig, PlexConfig};

    #[test]
    fn ctl_config_defaults_to_no_connectors() {
        assert_eq!(PoneglyphCtlConfig::default().gcal, None);
        assert_eq!(PoneglyphCtlConfig::default().gmail, None);
        assert_eq!(PoneglyphCtlConfig::default().plex, None);
        assert_eq!(PoneglyphCtlConfig::default().filesystem, None);
    }

    #[test]
    fn connector_configs_round_trip_through_toml() {
        let config = PoneglyphCtlConfig {
            filesystem: Some(FilesystemConfig::default()),
            gcal: Some(GcalConfig { enabled: true }),
            gmail: Some(GmailConfig::default()),
            plex: Some(PlexConfig { enabled: true }),
        };

        let toml = toml::to_string(&config).expect("serialize");
        let decoded: PoneglyphCtlConfig = toml::from_str(&toml).expect("deserialize");
        assert_eq!(decoded, config);
    }
}
