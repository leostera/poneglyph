# RFD0001: Local Backend Crate Boundary

## Status

Accepted and implemented for the current local backend split.

## Context

Poneglyph is now split between semantic runtime contracts and concrete local
storage primitives. The root `poneglyph` crate should remain usable for semantic
modeling, in-memory tests, custom backends, and runtime orchestration. Local disk
implementations belong in `poneglyph-local` so future backend crates, such as a
Cloudflare Workers backend, can implement the same contracts with different
storage/search primitives.

## Decision

- `poneglyph` owns graph semantics, domain types, service contracts, in-memory
  stores, replayable projection traits, query/schema/entity services, and runtime
  assembly contracts.
- `poneglyph-local` owns local durable implementations:
  - LSM append-only fact store as the default local fact backend.
  - SQLite append-only fact store as an explicit/reference compatibility backend.
  - SQLite entity projection store.
  - Tantivy search projection/index.
  - `LocalWorkspace` runtime opening, adapter access, and repair methods.
- `poneglyph-api` remains an optional gRPC/daemon boundary over a `poneglyph`
  runtime supplied by an embedder.
- Runtime storage is injected through `poneglyph::RuntimeStorageFactory`.
- Search is injected through the `poneglyph::SearchProjection` trait; `poneglyph-local`
  implements it with Tantivy, while core supplies an in-memory implementation for
  tests and custom assembly.

## Invariants

- Durable truth remains the append-only fact log.
- Entity storage is a replayable projection, never a mutable source of truth.
- Search storage is a replayable projection/index.
- Backend crates must implement the core traits rather than redefining graph
  semantics.

## Consequences

- Embedders wanting the standard local backend should use
  `poneglyph_local::LocalWorkspace::at(path).open()` or
  `LocalWorkspace::from_workspace(workspace).open_with_config(config)`. Legacy
  loose `open_*` helpers remain temporarily for compatibility but are deprecated.
- Embedders wanting custom primitives can provide their own `Store`,
  `EntityStore`, `SearchProjection`, and `RuntimeStorageFactory` implementations.
- A future `poneglyph-cloudflare` crate can map the same contracts onto D1/R2/KV
  or other Worker-compatible storage/search primitives.
- Some storage-specific error variants remain in `poneglyph::Error` for the
  current transition and should be generalized before adding non-local backend
  crates.
