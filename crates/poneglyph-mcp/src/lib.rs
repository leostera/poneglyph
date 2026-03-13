//! MCP adapter surface for the Poneglyph runtime.
//!
//! This crate is intentionally transport-neutral for now. It defines a small
//! server surface for listing tools and dispatching tool calls against a
//! [`poneglyph::Poneglyph`] runtime. A later slice can add stdio / JSON-RPC
//! transport on top of these types without changing tool semantics.

mod error;
mod server;
mod tool;

pub use error::{Error, Result};
pub use server::{PoneglyphMcpServer, PoneglyphMcpServerBuilder};
pub use tool::{CallToolResult, Tool, ToolCall};
