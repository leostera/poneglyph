# Poneglyph CLI Guide

## Scope

These instructions apply to `crates/poneglyph-cli/`.

## Purpose

- `poneglyph-cli` builds the in-repo `poneglyph` operator/reference binary.
- Keep process concerns here: CLI parsing, daemon lifecycle, shutdown, configuration commands, and client adapters.
- Prefer daemon-mediated operations for state, query, schema, and entity commands in this reference harness.
- Do not treat this crate as the only long-term application surface; domain daemons should embed the library crates directly.

## Working rules

- Prefer keeping business logic in `poneglyph-core`; `poneglyph-cli` should assemble and host it.
- Use `poneglyph-api` for gRPC client/server types and daemon service adapters.
- Split command handling into small modules instead of letting `cli.rs` grow.
- Add CLI smoke tests for user-facing flows and daemon lifecycle behavior.
