# Poneglyph Repository Guide

## Scope

These instructions apply to the whole repository unless a deeper `AGENTS.md` overrides them.

## Routing

- Use this file as the top-level router.
- When work is limited to one subsystem, read only the next relevant `AGENTS.md` instead of loading instructions for unrelated areas.
- The current deeper guide is `docs/AGENTS.md`; follow additional scoped guides if they are added.

## Project shape

- On this branch, Poneglyph is a strict-TypeScript semantic knowledge graph implementation for Cloudflare Workers and SQLite-backed Durable Objects.
- The Rust workspace and implementation were removed from this branch only; their earlier commits remain in Git history and other branches are unchanged.
- The reusable graph semantics are append-only facts; entities, indexes, and search-oriented views are derived/replayable projections.
- The repository contains package examples and validation harnesses, not a separate product service.

Architectural decisions should align with [RFD0003](docs/rfds/RFD0003-cloudflare-native-graph-database.md) for the historical fixed-leaf checkpoint and [RFD0004](docs/rfds/RFD0004-expandable-cloudflare-sharding.md) for the current expandable routing, capacity, and migration implementation contract, unless the user explicitly changes direction.

## Working rules

- The current TypeScript branch has **one** storage implementation, promoted from G and maintained directly in `poneglyph/src/storage/`. Do not recreate implementation selectors, parallel candidates or all-backend tournaments. See RFD0005's current direction; older experiment sections and reports are historical evidence.
- Harden that implementation against the independent conformance oracle before new benchmark loads. Use focused regressions during development; full tier runs are explicit certification checkpoints, not a default command after every edit.
- Commit often, commit eagerly, and use conventional commit messages.
- Prefer small, explicit architectural steps over broad speculative refactors.
- Preserve append-only semantics in new designs. Do not introduce mutable source-of-truth entity tables as the primary model.
- Treat facts as durable truth, entities as derived views, and projections as replayable workers.
- Keep Cloudflare resource changes isolated beneath `*.poneglyph.leostera.dev`; run local gates before deploying and clean up only resources created for validation.

## Documentation

- RFDs are the authoritative records for design decisions and contracts. Reflect substantive architecture, API, operations, and validation documentation in the relevant existing RFDs under `docs/rfds/`. Do not create a new RFD just to relocate an existing guide.
- README.md files and standard Markdown files such as AGENTS.md, CONTRIBUTING.md, and HACKING.md are allowed outside the RFD directory. READMEs may explain and link to the RFDs, but must not become competing authoritative design records. Do not add standalone topic guides there.
- When implementation diverges from an RFD, update the RFD or clearly call out the divergence.
