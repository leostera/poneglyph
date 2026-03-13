use derive_builder::Builder;
use serde::{Deserialize, Serialize};

/// MCP transport configuration for hosting Poneglyph over rmcp.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Builder)]
#[builder(pattern = "owned")]
pub struct PoneglyphMcpConfig {
    #[serde(default = "default_bind_addr")]
    #[builder(default = "default_bind_addr()")]
    pub bind_addr: String,
}

impl Default for PoneglyphMcpConfig {
    fn default() -> Self {
        Self {
            bind_addr: default_bind_addr(),
        }
    }
}

impl PoneglyphMcpConfig {
    pub fn builder() -> PoneglyphMcpConfigBuilder {
        PoneglyphMcpConfigBuilder::default()
    }
}

pub fn default_bind_addr() -> String {
    "127.0.0.1:8765".to_string()
}

#[cfg(test)]
mod tests {
    use super::{PoneglyphMcpConfig, default_bind_addr};

    #[test]
    fn default_bind_addr_uses_localhost() {
        assert_eq!(default_bind_addr(), "127.0.0.1:8765");
    }

    #[test]
    fn config_defaults_to_default_bind_addr() {
        assert_eq!(PoneglyphMcpConfig::default().bind_addr, default_bind_addr());
    }
}
