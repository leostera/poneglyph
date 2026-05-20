# Rust Crates Guide

## Scope

These instructions apply to `crates/` unless a deeper `AGENTS.md` overrides them.

## Routing

- When work is scoped to `crates/poneglyph-core`, read `crates/poneglyph-core/AGENTS.md`.
- When work is scoped to `crates/poneglyph-cli`, read `crates/poneglyph-cli/AGENTS.md`.
- When work is scoped to `crates/poneglyph-db`, read `crates/poneglyph-db/AGENTS.md`.

## Purpose

- `crates/` holds the Rust-only Poneglyph product.
- `poneglyph-cli` builds the user-facing `poneglyph` binary.
- `poneglyph-api` owns local gRPC API/protobuf definitions and service adapters.
- `poneglyph-core` owns the append-only fact log, consolidation, projections, schema/entity services, query engine, and workspace runtime.
- `poneglyph-db` owns the durable storage adapter boundary and is the staging point for moving SQLite/Datafox-specific database implementation out of core.

## Working rules

- Keep append-only fact semantics central.
- Prefer explicit, replay-friendly data flows over hidden mutable state.
- Reuse ideas from `old-borg-memory` where useful, but do not preserve prototype behavior that conflicts with the accepted RFD.
