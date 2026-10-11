# Embedding Poneglyph

Poneglyph's current implementation is an experimental TypeScript Cloudflare Worker backed by SQLite Durable Objects. The [`@leostera/poneglyph`](../poneglyph/package.json) package exports portable fact/value and bounded Datalog APIs plus a typed HTTP client. It does **not** bundle the storage runtime as a direct in-process or Durable Object embedding API; the earlier Rust crates were removed from this branch, with their source preserved in Git history.

## Use the TypeScript client

```ts
import { createDatabase, type FactInput } from "@leostera/poneglyph";

const db = createDatabase({ url: "https://your-worker.example" });
const graph = db.defineGraph({ id: "team-memory" });

const facts: readonly FactInput[] = [
  {
    source: "agent:team-memory",
    entity: "team:task:one",
    field: "team:task:title",
    value: { type: "text", value: "First task" },
  },
];

const txId = await graph.stateFacts(facts, { txId: "team-memory:seed-1" });
const result = await graph.query('team:task:title(Task, "First task")');
```

`createDatabase` and `defineGraph` construct local client objects; they do not register a graph or make a network request. Durable writes and reads go through the Worker HTTP API. `defineGraph` currently accepts only an ID: the Worker has no persisted graph catalog/schema endpoint, so a `schema` option would imply enforcement the server does not provide. Configure request headers or an injected `fetch` function to connect through an embedding application's authentication or service-binding adapter. Client-side headers alone do not secure the Worker.

## Throughput and consistency boundary

Each graph has one `GraphCoordinatorDO`. Every client using the same graph ID contends on this coordinator for serialized writes; the same coordinator also establishes the snapshot lease for reads. All writes preserve a single graph-visible commit sequence and transaction atomicity across participating shard leaves. Sharding distributes stored facts and query scans, but does **not** provide horizontal write scaling for one graph.

Cloudflare documents approximately 1,000 requests/second per Durable Object as a soft, workload-dependent limit, not a guaranteed rate or hard ceiling. It is not Poneglyph's measured throughput; the coordinator's transaction work requires workload-specific measurement. Different graph IDs have separate coordinators but are separate graphs. Splitting one logical graph across IDs changes query and transaction semantics and is not transparent partitioning.

The public client currently accepts Datalog source strings and returns fully buffered result rows, a `snapshotSeq`, and metrics. It has no streaming cursor or pagination API. See [`poneglyph/OPERATIONS.md`](../poneglyph/OPERATIONS.md) and [RFD0004](rfds/RFD0004-expandable-cloudflare-sharding.md) for route contracts, current limits, and bounded validation evidence.

## Durable/runtime boundary

SQLite-backed Durable Objects own graph coordination and private shard storage. Downstream Workers should call the HTTP client through an authenticated Worker endpoint or a service binding rather than opening another object's SQL storage. User-visible data remains append-only facts; active indexes, entities, and notifications are projections or signals that can be reconstructed from committed facts.

Direct SQL access and importing internal Durable Object classes are not stable public contracts. A higher-throughput per-graph write design would need to change the coordinator/visibility architecture while preserving the intended transaction guarantees; it is not solved by opening more client connections to the same graph.
