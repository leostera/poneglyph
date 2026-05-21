# RFD0000: Library and Optional Daemon API Architecture

## Status

Accepted for the library-first repository reset.

## Context

Poneglyph is a Rust semantic knowledge graph database library for agents. The
repository previously mixed product/app surfaces with the graph runtime, which
made it harder to stabilize the append-only fact model and embeddable storage
APIs.

The current scope is intentionally smaller: Poneglyph provides reusable library
crates for building domain-specific, disk-backed daemons. Product CLIs, desktop
apps, web apps, and domain-specific services should live outside this repository
unless they directly improve the embeddable library surface.

## Decision

- `crates/poneglyph` is the semantic graph runtime/library crate.
- `crates/poneglyph-local` is the preferred durable storage adapter and runtime
  opening crate.
- `crates/poneglyph-api` owns optional local gRPC protobuf definitions,
  generated client/server types, and daemon service adapters for embedders that
  want a daemon boundary.
- There is no in-repo product CLI or application crate.
- Durable truth remains the append-only fact log.
- Entity and search data are derived projections and must remain replayable.
- Datafox is an external sibling checkout and workspace path dependency at
  `../datafox`.

## Optional Daemon API

Embedders that want a local daemon boundary can use `poneglyph-api`. The current
transport is tonic/prost gRPC over localhost TCP. Unix-domain sockets remain a
future transport/lifecycle improvement for embedders that need it.

Typed protobuf payloads are the primary semantic daemon API for facts, state
writes, entities/search, schemas, and query results. Legacy `JsonResponse` RPCs
remain as compatibility shims during one transition window.

Typed protobuf migration status:

- Facts and values: `Value`, `Fact`, `ActiveFact`, `ListFactsResponse`,
  `StateFactTyped`, and `StateFactsTyped` cover fact listing and fact writes.
- Entities/search: `Entity`, `GetEntityResponse`, `ListEntitiesResponse`,
  `SearchHit`, and `SearchEntitiesResponse` cover entity get/list/search.
- Schema: `SchemaEntries`, `NamespaceSchema`, `KindSchema`, `FieldSchema`, and
  `SchemaDefinition` cover schema reads.
- Query: `QueryResponse`, `QueryRow`, `QueryBinding`, and `QueryValue` cover
  daemon query reads.
- Compatibility plan: keep legacy JSON RPCs until external callers have one
  migration window, then remove `JsonResponse` read RPCs and JSON fact write RPCs
  in favor of the typed methods.

Legacy JSON RPC audit:

| Legacy RPC | Typed replacement | Removal note |
| --- | --- | --- |
| `StateFact` | `StateFactTyped` | Remove with JSON fact write compatibility. |
| `StateFacts` | `StateFactsTyped` | Remove with JSON fact write compatibility. |
| `ListFacts` | `ListFactsTyped` | Remove after read clients migrate. |
| `Query` | `QueryTyped` | Remove after read clients migrate. |
| `GetEntity` | `GetEntityTyped` | Remove after read clients migrate. |
| `ListEntities` | `ListEntitiesTyped` | Remove after read clients migrate. |
| `SearchEntities` | `SearchEntitiesTyped` | Remove after read clients migrate. |
| `GetSchema` | `GetSchemaTyped` | Remove after read clients migrate. |

Compatibility handlers must share retrieval/validation helpers with typed
handlers until removal so behavior does not diverge during the transition window.

## Invariants

- Facts are append-only. Retraction is represented by a new retraction fact, not
  mutation or deletion of the original assertion.
- Entities are consolidated views derived from active facts.
- Schema is represented as facts and can be queried like other graph data.
- Query execution runs over the active graph using Datafox-backed Datalog.

## Consequences

- The repository is now an embeddable library/runtime, not a product application.
- A sibling `../datafox` checkout is required for local builds.
- The optional daemon protocol can evolve without reintroducing a general HTTP or
  app API.
- Schema application may be replayed safely: reapplying the same schema appends
  facts to the log while keeping the materialized schema view stable.
