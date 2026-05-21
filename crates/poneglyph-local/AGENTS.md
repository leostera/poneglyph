# Poneglyph Local Guide

## Scope

These instructions apply to `crates/poneglyph-local/`.

## Purpose

- `poneglyph-local` is the storage adapter crate for durable database-backed implementations.
- Keep graph semantics in `poneglyph`; this crate should implement concrete adapters and open/repair helpers.
- Keep local-only implementation details here: SQLite fact/entity stores, Tantivy search, local migrations, and repair behavior.

## Working rules

- Do not define source-of-truth entity tables. Entity storage remains a replayable projection.
- Do not move domain types (`Fact`, `Entity`, `Uri`, `Value`, schema/query types) here.
- Preserve append-only fact semantics and reuse the core `Store`/`EntityStore` contracts.
- Keep migrations and repair behavior explicit and covered by tests.
