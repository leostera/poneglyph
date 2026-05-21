# Review Readiness

This reset is ready to review as a narrow Rust-only Poneglyph library slice.

## Review scope

- Primary reusable surface: Rust graph database crates for building specific
  disk-backed daemons, such as a future `codedb` daemon.
- Product crates only: `poneglyph-core`, `poneglyph-db`, `poneglyph-api`, and the
  `poneglyph-cli` operator/reference harness.
- One in-repo binary: `poneglyph` from `crates/poneglyph-cli`.
- Local daemon transport: tonic/prost gRPC over localhost TCP when using the
  reference daemon/API boundary.
- Durable truth: append-only facts. Retractions append facts and do not mutate or
  delete assertions.
- Derived views: entities and search indexes are replayable projections.

## Intentional temporary seams

- The in-repo CLI/daemon should be treated as an operator/reference harness for
  the library crates, not as the only long-term application shape.
- Legacy JSON semantic RPCs remain in `poneglyph-api` for one compatibility
  window. The CLI uses typed protobuf RPCs for semantic daemon operations, and
  API parity tests protect the legacy shims until removal.
- Physical SQLite/search module movement from `poneglyph-core` to
  `poneglyph-db` is deferred by RFD0001. `poneglyph-db` is already the preferred
  disk-backed opener and adapter boundary.
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

For a quick user-surface smoke check after building:

```sh
cargo run -p poneglyph-cli -- --help
cargo run -p poneglyph-cli -- --version
```

Both commands should exit without opening or repairing a workspace.

The GitHub Actions workflow runs the same checks and checks out the sibling
`datafox` repository.

## Cleanup audit

The review branch should contain only the current Rust workspace crates and docs.
A final stale-reference audit should find no tracked legacy app/web/MCP/connector
crates, root reset notes, `opencode`/`.codex` config, or `poneglyphd` product
crate references outside historical Ralph notes and intentional compatibility
RFD text.

## Follow-up queue

These are intentionally not part of the reset review unless the scope changes:

- Expand `docs/embedding.md` into a compiled example once crate publishing/API
  polish starts.
- Remove legacy JSON semantic RPCs after one compatibility window, keeping the
  typed protobuf RPCs as the only semantic daemon API.
- Revisit RFD0001 and decide whether core keeps, removes, or feature-gates its
  compatibility SQLite/search defaults before physically moving those modules to
  `poneglyph-db`.
- Design the Unix-domain-socket daemon transport and socket cleanup lifecycle;
  keep localhost TCP as the portable fallback.
