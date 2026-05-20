# Poneglyph DB Guide

## Scope

These instructions apply to `crates/poneglyph-db/`.

## Purpose

- `poneglyph-db` is the storage adapter crate for durable database-backed implementations.
- Keep graph semantics in `poneglyph-core`; this crate should implement concrete adapters and open/repair helpers.
- Current initial boundary wraps the existing core SQLite adapters while the physical module move is staged.

## Working rules

- Do not define source-of-truth entity tables. Entity storage remains a replayable projection.
- Do not move domain types (`Fact`, `Entity`, `Uri`, `Value`, schema/query types) here.
- Preserve append-only fact semantics and reuse the core `Store`/`EntityStore` contracts.
- Keep migrations and repair behavior explicit and covered by tests.
