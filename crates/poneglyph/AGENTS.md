# Poneglyph Guide

## Scope

These instructions apply to `crates/poneglyph/`.

## Purpose

- `poneglyph` is the semantic graph database library crate.
- Keep domain types, traits, in-memory stores, services, consolidation, projection contracts, schema/entity management, query, and workspace runtime modular.
- Keep local SQLite/Tantivy backend implementation in `poneglyph-local`.

## Working rules

- Use typed errors from `error.rs`; avoid stringly wrappers.
- Keep append-only fact semantics central.
- Make service APIs stream-first where useful.
- Route filesystem layout and runtime config through `Workspace` and `Config` instead of scattering literal paths.
