use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("mcp server builder requires a poneglyph runtime")]
    MissingServerPoneglyph,
    #[error("unknown tool `{name}`")]
    UnknownTool { name: String },
    #[error("tool input deserialization failed for `{tool}`")]
    InvalidToolInput {
        tool: &'static str,
        #[source]
        source: serde_json::Error,
    },
    #[error("tool output serialization failed for `{tool}`")]
    InvalidToolOutput {
        tool: &'static str,
        #[source]
        source: serde_json::Error,
    },
    #[error("tool schema for `{tool}` must be a JSON object")]
    InvalidToolSchema { tool: String },
    #[error("invalid MCP bind address")]
    McpBindAddress(#[from] std::net::AddrParseError),
    #[error("mcp io error")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    RmcpServerInitialize(#[from] rmcp::service::ServerInitializeError),
    #[error(transparent)]
    RmcpJoin(#[from] tokio::task::JoinError),
    #[error(transparent)]
    Poneglyph(#[from] poneglyph::Error),
    #[error(transparent)]
    RmcpService(#[from] rmcp::ServiceError),
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::Error;

    #[test]
    fn unknown_tool_error_formats_tool_name() {
        let error = Error::UnknownTool {
            name: "Poneglyph-query".to_string(),
        };

        assert!(error.to_string().contains("Poneglyph-query"));
    }
}
