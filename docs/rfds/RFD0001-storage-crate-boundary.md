# RFD0001: Storage Crate Boundary

## Status

Accepted as a staged boundary. Physical SQLite/search module movement remains
explicitly deferred until the core default disk assembly decision below is
resolved.

## Context

The reset workspace now has the requested Rust-only crate shape in progress:

- `poneglyph-cli` builds the user-facing `poneglyph` binary.
- `poneglyph-api` owns the local gRPC API and daemon service adapter.
- `poneglyph-core` owns graph semantics, service contracts, in-memory stores, and core runtime types.
- `poneglyph-db` exists as the storage adapter staging crate and is the preferred disk-backed opener for CLI/daemon runtime assembly and repair.

The remaining split is harder than the CLI/API/core rename because current
storage code is not yet a physically isolated adapter layer. Store traits,
in-memory stores, SQLite stores, schema replay, and many adapter-specific tests
still live in `poneglyph-core` and share core domain types (`Fact`, `Entity`,
`Uri`, `Value`, `SchemaDefinition`, `Filter`, `ActiveFact`, and
`ActiveFilter`).

## Decision

Do not move storage code into `poneglyph-db` until the boundary is made explicit
inside `poneglyph-core`.

`poneglyph-core` remains the owner of semantic contracts:

- append-only fact semantics;
- fact, entity, URI, value, schema, and query domain types;
- store traits (`Store`, `EntityStore`) as service contracts;
- runtime type, builder, and projection wiring contracts;
- base schema bootstrapping and schema-as-facts behavior.

A future `poneglyph-db` crate should own concrete database adapters only:

- SQLite fact store implementation;
- SQLite entity store implementation;
- any Datafox-backed durable database/index adapter if it becomes separate from
  query planning/evaluation;
- migrations, connection/open helpers, and storage-specific repair operations.

In-memory stores should stay in `poneglyph-core` for fast semantic tests and for
runtime/service tests that should not depend on disk.

## Current Recommendation

Keep `poneglyph-db` as the public disk-backed adapter and runtime-opening crate,
but do not physically move SQLite/search modules yet. The injected
`RuntimeStorageFactory` seam now proves that process-level code can obtain disk
storage from `poneglyph-db` without making `poneglyph-core` depend on
`poneglyph-db`. However, `poneglyph-core` still intentionally has a default disk
assembly path for core runtime convenience and compatibility tests.

The next storage architecture decision should be one of these explicit options:

1. **Keep core defaults as compatibility:** leave SQLite/search implementations
   in core, treat `poneglyph-db` as the preferred external opener, and remove the
   physical move from near-term scope.
2. **Remove core disk defaults:** make core runtime construction require
   in-memory stores or an injected `RuntimeStorageFactory`, then move concrete
   SQLite/search modules and SQLite-specific tests to `poneglyph-db`.
3. **Gate core disk defaults behind a feature:** keep convenient core defaults
   for tests/development while allowing a pure semantic core build that has no
   concrete SQLite/search adapters.

For review readiness, option 1 is the safest current position. Options 2 or 3
should be a follow-up architecture change with their own focused migration.

Current core-local SQLite/search references are expected and should not be
mistaken for accidental boundary leaks:

- concrete modules under `poneglyph-core/src/facts/store/sqlite.rs` and
  `poneglyph-core/src/entities/store/sqlite.rs`;
- deprecated compatibility re-exports from `poneglyph-core`;
- `poneglyph-core/src/storage.rs`, which is the default compatibility storage
  factory used only when no external factory is injected;
- core SQLite semantic/property tests named `*_sqlite.rs`;
- `poneglyph-db` wrappers and adapter contract tests, which are the preferred
  public disk-backed entry points.

## Staged Implementation Status

The near-term extraction work is complete for review readiness:

1. Store traits and in-memory implementations remain in `poneglyph-core`.
2. SQLite/search construction is behind narrow core seam functions in
   `crates/poneglyph-core/src/storage.rs`; runtime assembly no longer directly
   constructs concrete adapters outside that seam.
3. `poneglyph-db` exists with a dependency on `poneglyph-core` and wraps the
   existing core SQLite/search implementations so callers can target the storage
   adapter crate before any physical module move.
4. Non-core consumers and integration tests call `poneglyph-db` adapter/runtime
   functions rather than constructing core SQLite types directly. The CLI opens
   disk-backed direct fallback, daemon runtimes, and repair through
   `poneglyph_db::open_runtime` / `poneglyph_db::repair_workspace`.
5. `poneglyph-db` re-exports the current SQLite adapter types as the preferred
   external import path while the physical modules remain in core. The old
   `poneglyph-core` SQLite re-exports are deprecated to discourage new external
   callers from binding directly to core storage implementations.
6. `poneglyph_core::RuntimeStorageFactory` lets disk-backed runtime storage be
   supplied by `poneglyph-db` without making core depend on db. `poneglyph-db`
   implements this seam with `DbRuntimeStorageFactory`, and core/DB tests prove
   injected factories avoid default SQLite paths and work through the core
   builder.

## Deferred Physical Move

Moving SQLite fact/entity store implementations and their SQLite-specific tests
into `poneglyph-db` is explicitly deferred. It should happen only if a follow-up
architecture change chooses option 2 or 3 from the recommendation section:
removing core disk defaults or feature-gating them. Until then, the remaining
direct references are intentionally core-local: the SQLite modules, deprecated
core re-exports, the default core storage seam, and core tests named
`*_sqlite.rs`.

Any future move should keep `cargo test --workspace` green after each step and
preserve existing append-only/replay tests.

## Non-goals

- Do not move `Fact`, `Entity`, `Uri`, `Value`, schema definitions, or query
  semantics into `poneglyph-db`.
- Do not make SQLite the semantic source of truth. It is an implementation of
  append-only fact storage, not the model.
- Do not introduce mutable source-of-truth entity tables. Entity tables remain
  replayable derived views.

## Consequences

This staged extraction reduces risk. `poneglyph-core` now has a local adapter
seam plus an injectable runtime storage factory, and `poneglyph-db` supplies the
factory used for process-level disk-backed runtime opening and repair. The next
implementation step is not another opportunistic file move; it is choosing
whether core keeps, removes, or feature-gates its compatibility SQLite/search
default path. Only after that choice should concrete modules move.
