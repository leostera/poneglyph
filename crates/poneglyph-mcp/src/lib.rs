//! MCP adapter surface for the Poneglyph runtime.
//!
//! This crate keeps tool semantics transport-neutral via [`PoneglyphMcpServer`]
//! while hiding the rmcp HTTP transport behind [`PoneglyphMcpServer::run`].

mod config;
mod error;
mod rmcp_http;
mod server;
mod tool;

pub use config::{PoneglyphMcpConfig, PoneglyphMcpConfigBuilder, default_bind_addr};
pub use error::{Error, Result};
pub use server::{PoneglyphMcpServer, PoneglyphMcpServerBuilder};
pub use tool::{CallToolResult, Tool, ToolCall};
