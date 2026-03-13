# Rust Crates Guide

## Scope

These instructions apply to `crates/` unless a deeper `AGENTS.md` overrides them.

## Routing

- When work is scoped to `crates/poneglyph`, read `crates/poneglyph/AGENTS.md`.
- When work is scoped to `crates/poneglyph-mcp`, read `crates/poneglyph-mcp/AGENTS.md`.
- When work is scoped to `crates/datafox`, read `crates/datafox/AGENTS.md`.
- When work is scoped to `crates/poneglyph-core`, read `crates/poneglyph-core/AGENTS.md`.
- When work is scoped to `crates/poneglyph-consolidation`, read `crates/poneglyph-consolidation/AGENTS.md`.
- When work is scoped to `crates/poneglyph-facts`, read `crates/poneglyph-facts/AGENTS.md`.

## Purpose

- `crates/` holds Rust runtime and storage code.
- This is where the daemon, fact log, consolidation, projections, query engine, and MCP service should eventually live.

## Working rules

- Keep append-only fact semantics central.
- Prefer explicit, replay-friendly data flows over hidden mutable state.
- Reuse ideas from `old-borg-memory` where useful, but do not preserve prototype behavior that conflicts with the accepted RFD.
