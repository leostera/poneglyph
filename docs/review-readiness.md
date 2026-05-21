# Review Readiness

This reset is ready to review as a narrow Rust-only Poneglyph slice.

## Review scope

- One user-facing binary: `poneglyph` from `crates/poneglyph-cli`.
- Product crates only: `poneglyph-cli`, `poneglyph-api`, `poneglyph-core`, and
  `poneglyph-db`.
- Local daemon transport: tonic/prost gRPC over localhost TCP.
- Durable truth: append-only facts. Retractions append facts and do not mutate or
  delete assertions.
- Derived views: entities and search indexes are replayable projections.

## Intentional temporary seams

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

For a quick user-surface smoke check after building, `poneglyph --help` and
`poneglyph --version` should exit without opening or repairing a workspace.

The GitHub Actions workflow runs the same checks and checks out the sibling
`datafox` repository.
