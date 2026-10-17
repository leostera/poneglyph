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

// Keep this token and the exact facts if you may need to retry after unknown delivery.
const {txId} = await graph.transact(facts, {clientRequestToken: "release:seed-001"});
const result = await graph.query(
  'app:service:blocked-by(Service, Task), app:task:status(Task, "open")',
);

console.log({ txId, snapshotSeq: result.snapshotSeq, rows: result.rows });
```

`createDatabase` and `defineGraph` are synchronous local configuration/handle constructors; they do not make a network request. Durable writes and queries are asynchronous. The returned query result contains fully buffered `rows`, the pinned `snapshotSeq`, and access `metrics`; it is **not** a streaming cursor or pagination API. Current Worker query limits cap results at 2,000 rows.

You can also bind one graph as the database's default and call `db.transact(...)` and `db.query(...)` directly:

```ts
const db = createDatabase({
  url: "https://your-worker.example",
  graphId: "release-assistant",
});
const {txId} = await db.transact(facts, {clientRequestToken: "release:seed-001"});
```

The server mints an internal transaction ID for each submission and returns it only in the successful `{ txId }` receipt. Request/network/protocol errors do not expose it, because delivery may be unknown. The client never retries automatically. To retry one logical request safely, provide the same optional `clientRequestToken` (a non-empty string of at most 256 UTF-8 bytes) and exact facts; the token is graph-scoped, concurrent duplicates share the durable outcome, changed facts conflict, and mappings are retained for seven days subject to capacity. Without a token, each submission is a new transaction. Internal sequences remain implementation details.

## API and architecture limits

`query` accepts the Worker-supported Datalog **source string** and validates it locally before sending it. Query objects/builders are not currently a public request format. `defineGraph({ id })` validates an ID and creates a local graph-scoped client handle; it does not register a graph or persist a schema. `getSchema()` is a read-only observation of active fields and root FactValue tags at a declared subtree-vector snapshot; it is not schema enforcement or a completeness claim. `defineGraph` intentionally accepts no schema or constraint options.

The Worker has one canonical storage implementation, promoted from G: a graph facade, sixteen entity-owner roots, sixteen pooled transaction ledgers, and sixteen bounded request-token coordinator buckets. Conflicting writes are fenced while independent owners can progress concurrently; reads pin a leased owner vector. The public numeric `snapshotSeq` is not a graph-global serialization promise. Older storage schemas are not automatically imported: use fresh namespaces unless already using the same schema8/routing9 format. Multiple graph IDs remain separate graphs, not transparent partitions. See [RFD0005's current implementation contract](../../docs/rfds/RFD0005-write-path-experiment.md#current-direction-one-implementation-2026-10-14) and the [operating procedures](../../docs/rfds/RFD0004-expandable-cloudflare-sharding.md#local-operating-and-review-gates).

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
# From the repository root:
bun install --frozen-lockfile
bun run build:package
cd packages/poneglyph
npm pack --dry-run
npm publish --access public
```

Publishing requires an npm account authorized for the `@leostera` scope and a fresh version in `package.json`. This repository currently has no `LICENSE` file or license metadata; choose and add the intended license before publishing a public package. Do not publish until the license and this experimental API surface are intentional.
