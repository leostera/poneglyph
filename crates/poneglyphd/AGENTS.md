# Poneglyphd Guide

## Scope

These instructions apply to `crates/poneglyphd/`.

## Purpose

- `poneglyphd` is the process/CLI host for the `poneglyph` runtime.
- Keep process concerns here: CLI parsing, daemon lifecycle, shutdown, and server adapters.

## Working rules

- Prefer keeping business logic in `poneglyph`; `poneglyphd` should assemble and host it.
- Split process wiring into small modules instead of letting `main.rs` grow into the daemon.
- Add CLI tests for parsing and daemon tests for runtime assembly.
