# Embedding Poneglyph

On this branch, Poneglyph's implementation is a strict-TypeScript Cloudflare Workers package. The earlier Rust crates have been removed from the branch; their source remains available through Git history. The current package is an experimental prototype rather than a released, stable embedding API.

## Use the package

The [`@leostera/poneglyph`](../poneglyph/package.json) package exports typed fact, identifier, graph-ID, and bounded Datalog parsing/evaluation modules. The canonical local setup, Worker routes, transaction contract, and deployment guidance are in [`poneglyph/OPERATIONS.md`](../poneglyph/OPERATIONS.md).

```ts
import { parseFactBatch, parseDatalogQuery } from "@leostera/poneglyph";

const batch = parseFactBatch({
  txId: "demo:tx:1",
  facts: [{
    source: "demo:client",
    entity: "demo:item:one",
    field: "demo:title",
    value: { type: "text", value: "First item" },
    retraction: false,
  }],
});

const query = parseDatalogQuery("demo:title(Item, \"First item\")");
```

Parsing gives a typed value; durable writes and graph reads still go through the Worker/Coordinator API. Do not treat direct SQL access or importing internal Durable Object classes as a stable public contract.

## Durable/runtime boundary

The package's Cloudflare Worker owns the request boundary. SQLite-backed Durable Objects own graph coordination and private shard storage. Downstream Workers should call a supported Worker/service binding or an HTTP API with authentication supplied by the embedding application rather than opening another object's SQL storage. User-visible data remains append-only facts; active indexes, entities, and notifications are projections or signals that can be reconstructed from committed facts.

The repository currently has no general-purpose SDK or stable service-binding API for arbitrary downstream deployments. The shared TODO example and its authenticated HTTP/WebSocket flow are being developed as an explicit demo surface; consult the operations guide and current RFDs rather than assuming undocumented routes are stable.
