# Rust Crates Guide

## Scope

These instructions apply to `crates/` unless a deeper `AGENTS.md` overrides them.

## Routing

- When work is scoped to `crates/poneglyph`, read `crates/poneglyph/AGENTS.md`.
- When work is scoped to `crates/poneglyph-api`, read `crates/poneglyph-api/AGENTS.md`.
- When work is scoped to `crates/poneglyph-local`, read `crates/poneglyph-local/AGENTS.md`.

## Purpose

- `crates/` holds the Rust-only Poneglyph embeddable library/runtime.
- `poneglyph` owns the append-only fact log, consolidation, projections, schema/entity services, query engine, and workspace runtime contracts.
- `poneglyph-local` owns the durable storage adapter boundary and is the staging point for moving SQLite/Datafox-specific database implementation out of core.
- `poneglyph-api` owns optional local gRPC API/protobuf definitions and service adapters for embedders that want a daemon boundary.

## Working rules

- Keep append-only fact semantics central.
- Prefer explicit, replay-friendly data flows over hidden mutable state.
- Keep domain-specific behavior out of the reusable library crates unless it belongs to the generic graph database model.
- Do not add in-repo application surfaces unless they directly support embedding Poneglyph as a semantic knowledge graph database library for agents.
