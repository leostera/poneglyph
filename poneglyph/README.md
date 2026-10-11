# `@leostera/poneglyph`

Experimental TypeScript primitives and an HTTP client for Poneglyph's Cloudflare Worker API. The package includes typed fact/value parsing, a bounded Datalog parser/evaluator, and `createDatabase` for graph writes and queries. It does **not** bundle the SQLite Durable Object runtime or provide a direct embedded storage API. Version `0.1.0` has no stable compatibility promise.

## Install

```sh
npm install @leostera/poneglyph
```

## Connect to a Worker

```ts
import { createDatabase, type FactInput } from "@leostera/poneglyph";

const db = createDatabase({ url: "https://your-worker.example" });
const graph = db.defineGraph({ id: "release-assistant" });

const facts: readonly FactInput[] = [
  {
    source: "agent:release-assistant",
    entity: "app:service:auth-api",
    field: "app:service:blocked-by",
    value: { type: "reference", value: "app:task:rotate-key" },
  },
  {
    source: "agent:release-assistant",
    entity: "app:task:rotate-key",
    field: "app:task:status",
    value: { type: "text", value: "open" },
  },
];

// Pass your own ID when you need to retry after an ambiguous network failure.
const txId = await graph.stateFacts(facts, { txId: "release:seed-001" });
const result = await graph.query(
  'app:service:blocked-by(Service, Task), app:task:status(Task, "open")',
);

console.log({ txId, snapshotSeq: result.snapshotSeq, rows: result.rows });
```

`createDatabase` and `defineGraph` are synchronous local configuration/handle constructors; they do not make a network request. Durable writes and queries are asynchronous. The returned query result contains fully buffered `rows`, the pinned `snapshotSeq`, and access `metrics`; it is **not** a streaming cursor or pagination API. Current Worker query limits cap results at 2,000 rows.

You can also bind one graph as the database's default and call `db.stateFacts(...)`, `db.transact(...)`, and `db.query(...)` directly:

```ts
const db = createDatabase({
  url: "https://your-worker.example",
  graphId: "release-assistant",
});
const txId = await db.stateFacts(facts, { txId: "release:seed-001" });
```

A generated transaction ID is used when `txId` is omitted. `stateFacts` (also available as `state`) returns that ID; `transact` returns `{ txId, commitSeq, status }`. Request, network, and malformed-response errors expose the transaction ID when a write may have reached the Worker. The client does not retry automatically; to retry safely, resend the same facts with the same ID. Reusing an ID with different content is a conflict.

## API and architecture limits

`query` accepts the Worker-supported Datalog **source string** and validates it locally before sending it. Query objects/builders are not currently a public request format. `defineGraph({ id })` validates an ID and creates a local graph-scoped client handle; it does not register a graph or persist a schema. The Worker has no graph catalog/schema-enforcement endpoint yet, so this API intentionally does not accept a `schema` option.

Every graph has one coordinator Durable Object. All clients writing to the same graph ID contend on that coordinator and share its serialized commit sequencer. Cloudflare documents approximately 1,000 requests/second per DO as a soft, workload-dependent limit, not a guaranteed rate or hard ceiling; actual Poneglyph write throughput requires workload-specific measurement. Sharding increases data placement capacity and distributes scans, but it does not horizontally scale commits for one graph. Multiple graph IDs use separate coordinators, but are separate graphs—not transparent partitions with graph-wide atomic writes or queries. See the [operations guide](OPERATIONS.md) and [RFD0004](../docs/rfds/RFD0004-expandable-cloudflare-sharding.md) for implemented limits and bounded evidence.

The client accepts `headers` and an injectable `fetch` function in `createDatabase` configuration for application authentication, testing, or a Worker service-binding adapter. Protect the Worker endpoint at the application boundary; configuring a client header does not itself add authentication to the prototype Worker.

## Portable fact and query primitives

```ts
import { parseFactBatch, parseDatalogQuery } from "@leostera/poneglyph";

const batch = parseFactBatch({
  txId: "release:seed-001",
  facts: [{
    source: "agent:release-assistant",
    entity: "app:task:rotate-key",
    field: "app:task:status",
    value: { type: "text", value: "open" },
    retraction: false,
  }],
});
if (!batch.ok) throw new Error(batch.error.message);

const query = parseDatalogQuery('app:task:status(Task, "open")');
if (!query.ok) throw new Error(query.error.message);
```

Parsers return typed `ParseResult` values rather than silently coercing malformed input. The package also exports fact/value/identifier types, the Datalog AST, `FactSource`, and the evaluator. Query syntax is a bounded subset; it is not general SQL or recursive Datalog.

## Build and publish

The package name is scoped because the unscoped npm name `poneglyph` is already taken. `publishConfig.access` is set to `public`; `prepublishOnly` runs the local package checks and `prepack` builds ESM JavaScript and TypeScript declarations into `dist/` before packing.

```sh
cd poneglyph
pnpm install
pnpm run build:package
npm pack --dry-run
npm publish --access public
```

Publishing requires an npm account authorized for the `@leostera` scope and a fresh version in `package.json`. This repository currently has no `LICENSE` file or license metadata; choose and add the intended license before publishing a public package. Do not publish until the license and this experimental API surface are intentional.
