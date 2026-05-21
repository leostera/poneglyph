# Rust Crates Guide

## Scope

These instructions apply to `crates/` unless a deeper `AGENTS.md` overrides them.

## Routing

- When work is scoped to `crates/poneglyph-core`, read `crates/poneglyph-core/AGENTS.md`.
- When work is scoped to `crates/poneglyph-api`, read `crates/poneglyph-api/AGENTS.md`.
- When work is scoped to `crates/poneglyph-db`, read `crates/poneglyph-db/AGENTS.md`.
- When work is scoped to `crates/poneglyph-cli`, read `crates/poneglyph-cli/AGENTS.md`.

## Purpose

- `crates/` holds the Rust-only Poneglyph library/runtime plus the reference operator CLI.
- `poneglyph-core` owns the append-only fact log, consolidation, projections, schema/entity services, query engine, and workspace runtime contracts.
- `poneglyph-db` owns the durable storage adapter boundary and is the staging point for moving SQLite/Datafox-specific database implementation out of core.
- `poneglyph-api` owns local gRPC API/protobuf definitions and service adapters for embedders that want a daemon boundary.
- `poneglyph-cli` builds the `poneglyph` operator/reference binary.

## Working rules

- Keep append-only fact semantics central.
- Prefer explicit, replay-friendly data flows over hidden mutable state.
- Keep domain-specific behavior out of the reusable library crates unless it belongs to the generic graph database model.
