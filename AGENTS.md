# Poneglyph Repository Guide

## Scope

These instructions apply to the whole repository unless a deeper `AGENTS.md` overrides them.

## Routing

- Use this file as the top-level router.
- When work is limited to one subsystem, read only the next relevant `AGENTS.md` instead of loading instructions for unrelated areas.
- Relevant deeper guides currently live in:
  `app/`,
  `packages/`,
  `packages/ui/`,
  `packages/i18n/`,
  `www/`,
  `crates/`,
  `docs/`,
  and `docs/rfds/`.

## Project shape

- Poneglyph is a local-first graph database built around append-only facts.
- The long-term product shape is a Rust daemon plus a JavaScript desktop app.
- `crates/old-borg-memory` is prior art and a reference implementation, not the final architecture.
- Architectural decisions should align with [`docs/rfds/RFD0001-initial-architecture.md`](/Users/leostera/Developer/github.com/leostera/poneglyph/docs/rfds/RFD0001-initial-architecture.md) unless the user explicitly changes direction.

## Working rules

- Prefer small, explicit architectural steps over broad speculative refactors.
- Preserve append-only semantics in new designs. Do not introduce mutable source-of-truth entity tables as the primary model.
- Treat facts as the durable truth, entities as derived views, and projections as replayable workers.
- Keep Rust responsibilities in the daemon/runtime layer and JavaScript responsibilities in the desktop/web UI layer.

## Documentation

- Significant architecture changes should update or add an RFD in `docs/rfds/`.
- When implementation diverges from an accepted RFD, update the RFD or clearly call out the divergence.

## Existing code

- Read `crates/old-borg-memory` before replacing it. Reuse ideas where useful, but do not preserve prototype behavior that conflicts with the RFD.
- In particular, be skeptical of any behavior that is not append-only, not transactional, or not replay-friendly.
