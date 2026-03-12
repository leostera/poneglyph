# Poneglyph Backend Guide

## Scope

These instructions apply to `crates/poneglyph/`.

## Purpose

- `poneglyph` is the main backend library crate.
- Keep domain types, stores, services, and consolidation logic modular, but prefer module boundaries over premature crate splits.

## Working rules

- Use typed errors from `error.rs`; avoid stringly wrappers.
- Keep append-only fact semantics central.
- Make service APIs stream-first.
- Route filesystem layout and runtime config through `Workspace` and `Config` instead of scattering literal paths.
