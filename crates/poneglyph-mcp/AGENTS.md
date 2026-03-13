# Poneglyph MCP Guide

## Scope

These instructions apply to `crates/poneglyph-mcp/`.

## Purpose

- `poneglyph-mcp` adapts the `poneglyph` runtime into an MCP-facing tool surface.
- Keep MCP protocol and transport concerns here instead of leaking them into `poneglyph`.

## Working rules

- Prefer a transport-neutral server surface first: tool listing, tool dispatch, and typed tool payloads.
- Keep business logic in `poneglyph`; this crate should translate requests and responses.
- Use `serde_json` only at the tool boundary.
