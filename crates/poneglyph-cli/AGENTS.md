# Poneglyph CLI Guide

## Scope

These instructions apply to `crates/poneglyph-cli/`.

## Purpose

- `poneglyph-cli` builds the single user-facing `poneglyph` binary.
- Keep process concerns here: CLI parsing, daemon lifecycle, shutdown, configuration commands, and client adapters.
- Prefer daemon-mediated operations for state, query, schema, and entity commands.

## Working rules

- Prefer keeping business logic in `poneglyph-core`; `poneglyph-cli` should assemble and host it.
- Use `poneglyph-api` for gRPC client/server types and daemon service adapters.
- Split command handling into small modules instead of letting `cli.rs` grow.
- Add CLI smoke tests for user-facing flows and daemon lifecycle behavior.
