# Poneglyph

Poneglyph is a local-first semantic knowledge graph database library for agents.

It is a reusable Rust database layer for building specific semantic graph
daemons. For example, an `agent-memory` daemon can embed Poneglyph as its append-only
fact store, schema/entity projection runtime, and Datafox-backed Datalog query
engine.

Scope guard: if a feature, crate, or workflow does not make Poneglyph better as
a library for building agent knowledge graphs, it should be deferred, moved out,
or deleted rather than expanded in this repository.

## Current workspace

- `crates/poneglyph` — core append-only fact model, schema/entity services,
  projections, query engine, runtime contracts, and workspace layout.
- `crates/poneglyph-local` — preferred durable storage adapter boundary and
  disk-backed runtime opener; see `docs/rfds/RFD0001-storage-crate-boundary.md`
  for the staged SQLite/search extraction decision.
- `crates/poneglyph-api` — optional local gRPC API/protobuf definitions and
  daemon service adapter. Typed protobuf RPCs are the primary semantic API;
  legacy JSON RPCs remain only as compatibility shims.
- `../datafox` — external sibling path dependency for Datalog parsing/evaluation.

## Embedding quickstart

Downstream daemons should embed `poneglyph` for semantic runtime contracts,
`poneglyph-local` for disk-backed workspace/storage assembly, and `poneglyph-api`
only when they want the local gRPC service boundary.

Prefer `poneglyph_local::open_workspace` for durable runtime assembly that loads
workspace configuration. Import SQLite adapter types from `poneglyph-local`; direct
`poneglyph` SQLite re-exports are deprecated compatibility paths.

```rust,no_run
use poneglyph::{Value, Workspace, fact, uri};
use poneglyph_local::open_workspace;

#[tokio::main]
async fn main() -> poneglyph::PoneResult<()> {
    let runtime = open_workspace(Workspace::at("./agent-memory.poneglyph")).await?;

    runtime
        .state_facts(vec![fact!(
            uri!("memory:item:first-note"),
            uri!("memory:title"),
            Value::text("First note")
        )])
        .await?;

    let rows = runtime
        .query_str(r#"memory:title(File, "First note")"#)
        .await?;
    println!("matched {} memory item(s)", rows.len());

    Ok(())
}
```

A compiled version of this flow lives at
`crates/poneglyph-local/examples/agent_memory_daemon.rs`, with direct library
coverage in `crates/poneglyph-local/tests/embedding.rs`.

## Typed values

- bare strings are text
- `Value::number(...)` stores a number
- `Value::bool(...)` stores a boolean
- `Value::ref_(...)` stores a reference
- tagged `Value` JSON is supported at serialization boundaries

## Architecture

See [`docs/embedding.md`](docs/embedding.md),
[`docs/rfds/RFD0000-cli-daemon-architecture.md`](docs/rfds/RFD0000-cli-daemon-architecture.md),
[`docs/rfds/RFD0001-storage-crate-boundary.md`](docs/rfds/RFD0001-storage-crate-boundary.md),
and [`docs/review-readiness.md`](docs/review-readiness.md).

## Development

Clone/check out Datafox next to this repository before building:

```text
github.com/leostera/poneglyph
github.com/leostera/datafox
```

`protoc` is required because `poneglyph-api` generates tonic/prost bindings at
build time.

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

CI expects this repository and Datafox to be checked out as siblings, matching
the local `../datafox` path dependency layout.
