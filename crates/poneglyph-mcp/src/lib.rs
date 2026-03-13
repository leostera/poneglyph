//! MCP adapter surface for the Poneglyph runtime.
//!
//! This crate keeps tool semantics transport-neutral via [`PoneglyphMcpServer`]
//! while hiding the rmcp stdio transport behind [`PoneglyphMcpServer::run`].

mod error;
mod rmcp_stdio;
mod server;
mod tool;

pub use error::{Error, Result};
pub use server::{PoneglyphMcpServer, PoneglyphMcpServerBuilder};
pub use tool::{CallToolResult, Tool, ToolCall};
