# Rust Crates Guide

## Scope

These instructions apply to `crates/` unless a deeper `AGENTS.md` overrides them.

## Purpose

- `crates/` holds Rust runtime and storage code.
- This is where the daemon, fact log, consolidation, projections, query engine, and MCP service should eventually live.

## Working rules

- Keep append-only fact semantics central.
- Prefer explicit, replay-friendly data flows over hidden mutable state.
- Reuse ideas from `old-borg-memory` where useful, but do not preserve prototype behavior that conflicts with the accepted RFD.
