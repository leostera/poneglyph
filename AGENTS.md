# Poneglyph Repository Guide


## Scope

These instructions apply to the whole repository unless a deeper `AGENTS.md` overrides them.

## Routing

- Use this file as the top-level router.
- When work is limited to one subsystem, read only the next relevant `AGENTS.md` instead of loading instructions for unrelated areas.
- Relevant deeper guides currently live in:
  `crates/`,
  `docs/`,
  and `docs/rfds/`.

## Project shape

- Poneglyph is a local-first semantic knowledge graph database library built around append-only facts.
- The long-term product shape is a reusable Rust library/runtime for building specific disk-backed agent knowledge graph daemons.
- There is no in-repo application surface; downstream products should embed the library crates directly.
- Architectural decisions should align with [`docs/rfds/RFD0000-cli-daemon-architecture.md`](/Users/leostera/Developer/github.com/leostera/poneglyph/docs/rfds/RFD0000-cli-daemon-architecture.md) and [`docs/rfds/RFD0001-storage-crate-boundary.md`](/Users/leostera/Developer/github.com/leostera/poneglyph/docs/rfds/RFD0001-storage-crate-boundary.md) unless the user explicitly changes direction.

## Working rules

- Commit often, commit eagerly, and use conventional commit messages.
- Prefer small, explicit architectural steps over broad speculative refactors.
- Preserve append-only semantics in new designs. Do not introduce mutable source-of-truth entity tables as the primary model.
- Treat facts as the durable truth, entities as derived views, and projections as replayable workers.
- Keep reusable graph semantics in `poneglyph-core`, durable disk-backed assembly in `poneglyph-db`, and optional local service boundaries in `poneglyph-api`.

## Documentation

- Significant architecture changes should update or add an RFD in `docs/rfds/`.
- When implementation diverges from an accepted RFD, update the RFD or clearly call out the divergence.
