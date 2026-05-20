# RFD0001: Storage Crate Boundary

## Status

Proposed.

## Context

The reset workspace now has the requested Rust-only crate shape in progress:

- `poneglyph-cli` builds the user-facing `poneglyph` binary.
- `poneglyph-api` owns the local gRPC API and daemon service adapter.
- `poneglyph-core` owns graph semantics, runtime assembly, services, and stores.
- `poneglyph-db` is planned but not yet extracted.

The remaining split is harder than the CLI/API/core rename because current
storage code is not an isolated adapter layer. Store traits, in-memory stores,
SQLite stores, schema replay, runtime assembly, and tests all live in
`poneglyph-core` and share core domain types (`Fact`, `Entity`, `Uri`, `Value`,
`SchemaDefinition`, `Filter`, `ActiveFact`, and `ActiveFilter`).

## Decision

Do not move storage code into `poneglyph-db` until the boundary is made explicit
inside `poneglyph-core`.

`poneglyph-core` remains the owner of semantic contracts:

- append-only fact semantics;
- fact, entity, URI, value, schema, and query domain types;
- store traits (`Store`, `EntityStore`) as service contracts;
- runtime assembly and projection wiring;
- base schema bootstrapping and schema-as-facts behavior.

A future `poneglyph-db` crate should own concrete database adapters only:

- SQLite fact store implementation;
- SQLite entity store implementation;
- any Datafox-backed durable database/index adapter if it becomes separate from
  query planning/evaluation;
- migrations, connection/open helpers, and storage-specific repair operations.

In-memory stores should stay in `poneglyph-core` for fast semantic tests and for
runtime/service tests that should not depend on disk.

## Extraction Plan

1. Keep store traits and in-memory implementations in `poneglyph-core`.
2. Move SQLite-specific modules behind narrow constructor functions in
   `poneglyph-core` first, so runtime assembly calls an adapter boundary rather
   than concrete modules directly.
3. Introduce `poneglyph-db` with a dependency on `poneglyph-core`.
4. Move SQLite fact/entity store implementations and their SQLite-specific tests
   into `poneglyph-db`.
5. Re-export database adapters from `poneglyph-core` only if needed for CLI/tests;
   otherwise have the runtime depend on adapter constructors through an explicit
   feature or thin integration module.
6. Keep `cargo test --workspace` green after each move and preserve existing
   append-only/replay tests.

## Non-goals

- Do not move `Fact`, `Entity`, `Uri`, `Value`, schema definitions, or query
  semantics into `poneglyph-db`.
- Do not make SQLite the semantic source of truth. It is an implementation of
  append-only fact storage, not the model.
- Do not introduce mutable source-of-truth entity tables. Entity tables remain
  replayable derived views.

## Consequences

This defers the physical `poneglyph-db` crate extraction but reduces risk. The
next implementation step should be a small adapter seam in `poneglyph-core`, not
a broad cross-crate move.
