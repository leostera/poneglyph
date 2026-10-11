# Poneglyph Repository Guide

## Scope

These instructions apply to the whole repository unless a deeper `AGENTS.md` overrides them.

## Routing

- Use this file as the top-level router.
- When work is limited to one subsystem, read only the next relevant `AGENTS.md` instead of loading instructions for unrelated areas.
- Relevant deeper guides live in `poneglyph/`, `docs/`, and `docs/rfds/`.

## Project shape

- On this branch, Poneglyph is a strict-TypeScript semantic knowledge graph implementation for Cloudflare Workers and SQLite-backed Durable Objects.
- The Rust workspace and implementation were removed from this branch only; their earlier commits remain in Git history and other branches are unchanged.
- The reusable graph semantics are append-only facts; entities, indexes, and search-oriented views are derived/replayable projections.
- The repository contains package examples and validation harnesses, not a separate product service.

Architectural decisions should align with [RFD0003](docs/rfds/RFD0003-cloudflare-native-graph-database.md) for the completed fixed-leaf checkpoint and [RFD0004](docs/rfds/RFD0004-expandable-cloudflare-sharding.md) for the proposed expandable routing, capacity, and migration contract, unless the user explicitly changes direction.

## Working rules

- Commit often, commit eagerly, and use conventional commit messages.
- Prefer small, explicit architectural steps over broad speculative refactors.
- Preserve append-only semantics in new designs. Do not introduce mutable source-of-truth entity tables as the primary model.
- Treat facts as durable truth, entities as derived views, and projections as replayable workers.
- Keep Cloudflare resource changes isolated beneath `*.poneglyph.leostera.dev`; run local gates before deploying and clean up only resources created for validation.

## Documentation

- Significant architecture changes should update or add an RFD in `docs/rfds/`.
- When implementation diverges from an RFD, update the RFD or clearly call out the divergence.
