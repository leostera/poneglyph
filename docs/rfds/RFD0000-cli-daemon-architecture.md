# RFD0000: CLI and Daemon Architecture

## Status

Accepted for the repository reset.

## Context

Poneglyph is being reduced to a Rust-only local semantic graph database for
agents. The repository previously mixed a desktop app, web/app packages,
connectors, API servers, MCP integration, and an in-tree Datafox copy. That made
it hard to stabilize the core append-only graph runtime.

The new product surface is a single `poneglyph` CLI. The CLI manages a local
daemon and exposes facts, schemas, entities, and Datalog queries.

## Decision

- The only user-facing binary is `poneglyph`.
- `crates/poneglyph` is the core runtime/library crate.
- `crates/poneglyphd` is the CLI/process host crate and builds the `poneglyph`
  binary.
- Durable truth remains the append-only fact log.
- Entity and search data are derived projections and must remain replayable.
- The CLI talks to the daemon over gRPC when the daemon is available.
- CLI commands may temporarily fall back to direct workspace access while the
  daemon protocol is still hardening.
- Datafox is an external sibling checkout and workspace path dependency at
  `../datafox`.

## CLI Namespaces

```text
poneglyph server start|stop|restart|status|repair
poneglyph config list|get|set
poneglyph schema list|get|apply
poneglyph fact state|retract
poneglyph entity get
poneglyph query <datalog>
```

## Daemon API

The daemon currently exposes gRPC on localhost TCP via `rpc.bind_addr`, default
`127.0.0.1:5747`. This is intentionally narrow and local-only.

Unix-domain sockets are technically compatible with tonic by building a custom
transport channel around `tokio::net::UnixStream` and `Endpoint::connect_with_connector`.
That should become the default Unix transport once daemon lifecycle and socket
path cleanup are designed. Named pipes or localhost TCP can remain the Windows
fallback. For now, localhost TCP keeps the CLI portable while the command API is
still changing.

RPC payloads still use JSON for facts, schemas, entities, and query results in
places. This keeps the boundary flexible during CLI design. Typed protobuf
messages should replace JSON once the API stabilizes, but not before the fact,
value, schema, and query-result shapes have stopped changing.

## Invariants

- Facts are append-only. Retraction is represented by a new retraction fact, not
  mutation or deletion of the original assertion.
- Entities are consolidated views derived from active facts.
- Schema is represented as facts and can be queried like other graph data.
- Query execution runs over the active graph using Datafox-backed Datalog.

## Consequences

- The reset removes app/web/connector/API/MCP concerns from this repository.
- A sibling `../datafox` checkout is required for local builds.
- The daemon protocol can evolve without reintroducing a general HTTP or app API.
- `schema apply` may be replayed safely: reapplying the same schema appends facts
  to the log while keeping the materialized schema view stable.
