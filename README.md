# Poneglyph

Poneglyph is a local-first semantic graph database for agents.

This repository is being reset around one product surface: a Rust `poneglyph` CLI
that hosts a local daemon and manages append-only facts, schemas, consolidated
entities, and Datafox-backed Datalog queries.

## Current workspace

- `crates/poneglyph` — core append-only fact store, schema/entity services,
  projections, query engine, runtime, and disk-backed workspace layout.
- `crates/poneglyphd` — CLI/process host that builds the `poneglyph` binary.
- `../datafox` — external path dependency for Datalog parsing/evaluation.

## CLI shape

```text
poneglyph server start|stop|restart|status|repair
poneglyph config list|get|set
poneglyph schema list|get|apply
poneglyph fact state|retract
poneglyph entity get
poneglyph query <datalog>
```

Config commands still operate directly on the workspace config file. Schema/fact/query/entity commands try the daemon gRPC API first and fall back to direct workspace access when the daemon is offline. `poneglyph server start` exposes the gRPC API over localhost TCP (`rpc.bind_addr`, default `127.0.0.1:5747`).

## Development

```sh
cargo check --workspace
cargo test --workspace
```
