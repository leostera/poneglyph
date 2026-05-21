# Poneglyph Guide

## Scope

These instructions apply to `crates/poneglyph/`.

## Purpose

- `poneglyph` is the main backend library crate.
- Keep domain types, stores, services, consolidation, projections, schema/entity management, query, and workspace runtime modular.
- A future `poneglyph-local` crate may extract storage/Datafox-specific implementation when that boundary is clearer.

## Working rules

- Use typed errors from `error.rs`; avoid stringly wrappers.
- Keep append-only fact semantics central.
- Make service APIs stream-first where useful.
- Route filesystem layout and runtime config through `Workspace` and `Config` instead of scattering literal paths.
