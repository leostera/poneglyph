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
- `crates/poneglyph-cli` is the CLI/process host crate and builds the `poneglyph`
  binary.
- `crates/poneglyph-api` owns local gRPC protobuf definitions, generated client/server
  types, and daemon service adapters.
- `crates/poneglyph-core` is the core runtime/library crate.
- `crates/poneglyph-db` owns the durable storage adapter boundary and is the
  staging point for the SQLite/Datafox split; see
  `RFD0001-storage-crate-boundary.md` for the proposed extraction boundary.
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
poneglyph fact state|retract|list
poneglyph entity get|list|search
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

The primary CLI daemon paths now use typed protobuf payloads for facts, state
writes, entities/search, schemas, and query results. Legacy `JsonResponse` RPCs
remain as compatibility shims during one transition window, but new CLI behavior
should target typed RPCs first.

Typed protobuf migration status:

- Facts and values: `Value`, `Fact`, `ActiveFact`, `ListFactsResponse`,
  `StateFactTyped`, and `StateFactsTyped` cover fact listing and fact writes.
- Entities/search: `Entity`, `GetEntityResponse`, `ListEntitiesResponse`,
  `SearchHit`, and `SearchEntitiesResponse` cover entity get/list/search.
- Schema: `BaseSchema`-equivalent `SchemaEntries`, `NamespaceSchema`,
  `KindSchema`, `FieldSchema`, and `SchemaDefinition` cover schema reads.
- Query: `QueryResponse`, `QueryRow`, `QueryBinding`, and `QueryValue` cover
  daemon query reads, while the CLI adapts the typed response back to the
  established substitution JSON shape for `--json` compatibility.
- Compatibility plan: keep legacy JSON RPCs until external callers have one
  release window to migrate, then remove `JsonResponse` read RPCs and JSON fact
  write RPCs in favor of the typed methods.

Legacy JSON RPC audit:

| Legacy RPC | Typed replacement | Current CLI use | Removal note |
| --- | --- | --- | --- |
| `StateFact` | `StateFactTyped` | none | Remove with JSON fact write compatibility. |
| `StateFacts` | `StateFactsTyped` | none | Remove with JSON fact write compatibility. |
| `ListFacts` | `ListFactsTyped` | none | Remove after read clients migrate. |
| `Query` | `QueryTyped` | none | Remove after read clients migrate. |
| `GetEntity` | `GetEntityTyped` | none | Remove after read clients migrate. |
| `ListEntities` | `ListEntitiesTyped` | none | Remove after read clients migrate. |
| `SearchEntities` | `SearchEntitiesTyped` | none | Remove after read clients migrate. |
| `GetSchema` | `GetSchemaTyped` | none | Remove after read clients migrate. |

The CLI is intentionally no longer a legacy JSON RPC client for semantic
operations. Compatibility handlers must share retrieval/validation helpers with
the typed handlers until removal so behavior does not diverge during the
transition window.

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
