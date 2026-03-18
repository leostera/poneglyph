use derive_builder::Builder;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Builder)]
#[builder(pattern = "owned")]
pub struct PoneglyphApiConfig {
    #[serde(default = "default_bind_addr")]
    #[builder(default = "default_bind_addr()")]
    pub bind_addr: String,
    #[serde(default)]
    #[builder(default)]
    pub google_auth_base_url: Option<String>,
}

impl Default for PoneglyphApiConfig {
    fn default() -> Self {
        Self {
            bind_addr: default_bind_addr(),
            google_auth_base_url: None,
        }
    }
}

impl PoneglyphApiConfig {
    pub fn builder() -> PoneglyphApiConfigBuilder {
        PoneglyphApiConfigBuilder::default()
    }
}

pub fn default_bind_addr() -> String {
    "127.0.0.1:8787".to_string()
}

#[cfg(test)]
mod tests {
    use super::{PoneglyphApiConfig, default_bind_addr};

    #[test]
    fn default_bind_addr_uses_localhost() {
        assert_eq!(default_bind_addr(), "127.0.0.1:8787");
    }

    #[test]
    fn config_defaults_to_default_bind_addr() {
        assert_eq!(PoneglyphApiConfig::default().bind_addr, default_bind_addr());
        assert_eq!(PoneglyphApiConfig::default().google_auth_base_url, None);
    }
}
