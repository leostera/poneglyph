# RFD0001: Storage Crate Boundary

## Status

Accepted as a staged boundary. Physical SQLite/search module movement remains
explicitly deferred until the core default disk assembly decision below is
resolved.

## Context

The reset workspace now has a Rust-only library crate shape:

- `poneglyph` owns graph semantics, service contracts, in-memory stores, and core runtime types.
- `poneglyph-local` exists as the storage adapter staging crate and is the preferred disk-backed opener for embedded daemon runtime assembly and repair.
- `poneglyph-api` owns the optional local gRPC API and daemon service adapter for embedders that want that boundary.

The remaining split is hard because current storage code is not yet a physically
isolated adapter layer. Store traits,
in-memory stores, SQLite stores, schema replay, and many adapter-specific tests
still live in `poneglyph` and share core domain types (`Fact`, `Entity`,
`Uri`, `Value`, `SchemaDefinition`, `Filter`, `ActiveFact`, and
`ActiveFilter`).

## Decision

Do not move storage code into `poneglyph-local` until the boundary is made explicit
inside `poneglyph`.

`poneglyph` remains the owner of semantic contracts:

- append-only fact semantics;
- fact, entity, URI, value, schema, and query domain types;
- store traits (`Store`, `EntityStore`) as service contracts;
- runtime type, builder, and projection wiring contracts;
- base schema bootstrapping and schema-as-facts behavior.

A future `poneglyph-local` crate should own concrete database adapters only:

- SQLite fact store implementation;
- SQLite entity store implementation;
- any Datafox-backed durable database/index adapter if it becomes separate from
  query planning/evaluation;
- migrations, connection/open helpers, and storage-specific repair operations.

In-memory stores should stay in `poneglyph` for fast semantic tests and for
runtime/service tests that should not depend on disk.

## Current Recommendation

Keep `poneglyph-local` as the public disk-backed adapter and runtime-opening crate,
but do not physically move SQLite/search modules yet. The injected
`RuntimeStorageFactory` seam now proves that process-level code can obtain disk
storage from `poneglyph-local` without making `poneglyph` depend on
`poneglyph-local`. However, `poneglyph` still intentionally has a default disk
assembly path for core runtime convenience and compatibility tests.

The next storage architecture decision should be one of these explicit options:

1. **Keep core defaults as compatibility:** leave SQLite/search implementations
   in core, treat `poneglyph-local` as the preferred external opener, and remove the
   physical move from near-term scope.
2. **Remove core disk defaults:** make core runtime construction require
   in-memory stores or an injected `RuntimeStorageFactory`, then move concrete
   SQLite/search modules and SQLite-specific tests to `poneglyph-local`.
3. **Gate core disk defaults behind a feature:** keep convenient core defaults
   for tests/development while allowing a pure semantic core build that has no
   concrete SQLite/search adapters.

For review readiness, option 1 is the safest current position. Options 2 or 3
should be a follow-up architecture change with their own focused migration.

Current core-local SQLite/search references are expected and should not be
mistaken for accidental boundary leaks:

- concrete modules under `poneglyph/src/facts/store/sqlite.rs` and
  `poneglyph/src/entities/store/sqlite.rs`;
- deprecated compatibility re-exports from `poneglyph`;
- `poneglyph/src/storage.rs`, which is the default compatibility storage
  factory used only when no external factory is injected;
- core SQLite semantic/property tests named `*_sqlite.rs`;
- `poneglyph-local` wrappers and adapter contract tests, which are the preferred
  public disk-backed entry points.

## Staged Implementation Status

The near-term extraction work is complete for review readiness:

1. Store traits and in-memory implementations remain in `poneglyph`.
2. SQLite/search construction is behind narrow core seam functions in
   `crates/poneglyph/src/storage.rs`; runtime assembly no longer directly
   constructs concrete adapters outside that seam.
3. `poneglyph-local` exists with a dependency on `poneglyph` and wraps the
   existing core SQLite/search implementations so callers can target the storage
   adapter crate before any physical module move.
4. Non-core consumers and integration tests call `poneglyph-local` adapter/runtime
   functions rather than constructing core SQLite types directly. Embedders open
   disk-backed runtimes and repair through `poneglyph_local::open_workspace`,
   `poneglyph_local::open_runtime`, and `poneglyph_local::repair_workspace`.
5. `poneglyph-local` re-exports the current SQLite adapter types as the preferred
   external import path while the physical modules remain in core. The old
   `poneglyph` SQLite re-exports are deprecated to discourage new external
   callers from binding directly to core storage implementations.
6. `poneglyph::RuntimeStorageFactory` lets disk-backed runtime storage be
   supplied by `poneglyph-local` without making core depend on db. `poneglyph-local`
   implements this seam with `DbRuntimeStorageFactory`, and core/DB tests prove
   injected factories avoid default SQLite paths and work through the core
   builder.

## Deferred Physical Move

Moving SQLite fact/entity store implementations and their SQLite-specific tests
into `poneglyph-local` is explicitly deferred. It should happen only if a follow-up
architecture change chooses option 2 or 3 from the recommendation section:
removing core disk defaults or feature-gating them. Until then, the remaining
direct references are intentionally core-local: the SQLite modules, deprecated
core re-exports, the default core storage seam, and core tests named
`*_sqlite.rs`.

Any future move should keep `cargo test --workspace` green after each step and
preserve existing append-only/replay tests.

## Non-goals

- Do not move `Fact`, `Entity`, `Uri`, `Value`, schema definitions, or query
  semantics into `poneglyph-local`.
- Do not make SQLite the semantic source of truth. It is an implementation of
  append-only fact storage, not the model.
- Do not introduce mutable source-of-truth entity tables. Entity tables remain
  replayable derived views.

## Consequences

This staged extraction reduces risk. `poneglyph` now has a local adapter
seam plus an injectable runtime storage factory, and `poneglyph-local` supplies the
factory used for process-level disk-backed runtime opening and repair. The next
implementation step is not another opportunistic file move; it is choosing
whether core keeps, removes, or feature-gates its compatibility SQLite/search
default path. Only after that choice should concrete modules move.
