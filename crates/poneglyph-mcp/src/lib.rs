//! MCP adapter surface for the Poneglyph runtime.
//!
//! This crate keeps tool semantics transport-neutral via [`PoneglyphMcpServer`]
//! and also provides an rmcp-backed stdio host via [`RmcpServer`].

mod error;
mod rmcp_stdio;
mod server;
mod tool;

pub use error::{Error, Result};
pub use rmcp_stdio::RmcpServer;
pub use server::{PoneglyphMcpServer, PoneglyphMcpServerBuilder};
pub use tool::{CallToolResult, Tool, ToolCall};
