# Embedding Poneglyph

Poneglyph is intended to be embedded by domain-specific, disk-backed daemon
applications. This repository intentionally contains no product CLI; downstream
daemons embed the library crates directly.

A daemon such as `agent-memory` should generally depend on these crates:

- `poneglyph-core` for facts, URIs, values, schema/entity/query contracts, and
  the runtime builder.
- `poneglyph-db` for the default durable workspace-backed runtime assembly,
  workspace-config loading helper, repair helpers, and preferred SQLite adapter
  import paths.
- `poneglyph-api` only if the daemon wants to expose the local tonic/prost gRPC
  boundary or reuse the reference daemon service adapter.

Prefer `poneglyph_db::open_workspace` for disk-backed runtime assembly that
loads the workspace `config.toml`. Use `poneglyph_db::open_runtime` when the
embedding daemon wants to provide configuration directly. Import
`SqliteFactStore` and `SqliteEntityStore` from `poneglyph-db` if a daemon needs
adapter-level access; the matching `poneglyph-core` re-exports are deprecated
compatibility paths while the physical module move is staged.

## Minimal disk-backed runtime

```rust,no_run
use poneglyph_core::{Value, Workspace, fact, uri};
use poneglyph_db::open_workspace;

#[tokio::main]
async fn main() -> poneglyph_core::PoneResult<()> {
    let workspace = Workspace::at("./agent-memory.poneglyph");
    let runtime = open_workspace(workspace).await?;

    runtime
        .state_facts(vec![fact!(
            uri!("memory:item:first-note"),
            uri!("memory:title"),
            Value::text("First note")
        )])
        .await?;

    let rows = runtime.query_str(r#"memory:title(File, "First note")"#).await?;
    println!("{rows:#?}");

    Ok(())
}
```

This path opens the durable fact store, entity projection store, and search index
through `poneglyph-db`. The same flow is compiled in
`crates/poneglyph-db/examples/agent_memory_daemon.rs` and covered by
`crates/poneglyph-db/tests/embedding.rs`. Facts remain the durable source of
truth; entities and search results are derived views that can be replayed.

## Daemon pattern

An embedding daemon typically owns its domain protocol and lifecycle while using
Poneglyph for storage and semantic queries:

1. Choose a domain workspace path, for example `~/.agent-memory/poneglyph`.
2. Open the runtime through `poneglyph_db::open_workspace`.
3. Start background runtime workers with `Arc<Poneglyph>::run()` if the daemon
   needs live entity/search projection updates.
4. Translate domain requests into append-only facts and queries.
5. Expose domain-specific APIs from the embedding daemon. Use `poneglyph-api`
   only when the generic local gRPC boundary is useful.

## Invariants embedders must preserve

- Append new facts instead of mutating source-of-truth rows.
- Represent retractions as retraction facts.
- Treat entities and search indexes as replayable projections.
- Keep domain-specific entity tables as derived/read models, not durable truth.
