//! MCP adapter surface for the Poneglyph runtime.
//!
//! This crate keeps tool semantics transport-neutral via [`PoneglyphMcpServer`]
//! while exposing an axum-mountable rmcp HTTP router for embedding in a larger
//! API server.

mod error;
mod rmcp_http;
mod server;
mod tool;

pub use error::{Error, Result};
pub use server::{
    AgentMessageHandler, AgentMessageRequest, AgentMessageResponse, PoneglyphMcpServer,
    PoneglyphMcpServerBuilder,
};
pub use tool::{CallToolResult, Tool, ToolCall};
