# Review Readiness

This reset is ready to review as a narrow Rust-only Poneglyph library slice.
Poneglyph's scope is a reusable semantic knowledge graph database for agents;
things that do not advance that library/embedding story should be put aside,
moved out, or deleted rather than grown here.

## Review scope

- Primary reusable surface: Rust graph database crates for building specific
  disk-backed daemons, such as a future `agent-memory` daemon.
- Product crates only: `poneglyph`, `poneglyph-local`, and `poneglyph-api`.
- No in-repo product CLI or application crate.
- Local daemon transport: tonic/prost gRPC over localhost TCP when using the
  reference daemon/API boundary.
- Durable truth: append-only facts. Retractions append facts and do not mutate or
  delete assertions.
- Derived views: entities and search indexes are replayable projections.

## Intentional temporary seams

- Downstream daemons should embed the library crates directly; this repository
  should not grow unrelated product/application surfaces.
- Legacy JSON semantic RPCs remain in `poneglyph-api` for one compatibility
  window. Typed protobuf RPCs are the primary semantic daemon boundary, and API parity
  tests protect the legacy shims until removal.
- SQLite fact/entity stores and Tantivy search live in `poneglyph-local`; `poneglyph`
  keeps semantic traits, runtime contracts, and in-memory defaults.
- Unix-domain sockets are not implemented yet. RFD0000 records the local TCP
  limitation and the future UDS direction.

## Expected local layout

`datafox` is an external sibling checkout:

```text
github.com/leostera/poneglyph
github.com/leostera/datafox
```

`protoc` is required because `poneglyph-api` generates tonic/prost bindings at
build time.

## Review commands

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

The GitHub Actions workflow runs the same checks and checks out the sibling
`datafox` repository.

## Cleanup audit

The review branch should contain only the current Rust workspace crates and docs.
A final stale-reference audit should find no tracked legacy app/web/MCP/connector
crates, root reset notes, `opencode`/`.codex` config, or removed CLI/product crate references outside historical Ralph notes and
intentional compatibility RFD text. Future additions should pass the same scope test: they must directly
help embedders build semantic knowledge graph daemons for agents.

## Follow-up queue

These are intentionally not part of the reset review unless the scope changes:

- Expand `docs/embedding.md` into a compiled example once crate publishing/API
  polish starts.
- Remove legacy JSON semantic RPCs after one compatibility window, keeping the
  typed protobuf RPCs as the only semantic daemon API.
- Generalize remaining local-backend coupling, such as storage-specific error
  variants, out of `poneglyph` before adding non-local backend crates.
- Design the Unix-domain-socket daemon transport and socket cleanup lifecycle;
  keep localhost TCP as the portable fallback.
