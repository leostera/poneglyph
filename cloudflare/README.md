# `@leostera/poneglyph`

Strict TypeScript package and Cloudflare Workers/Durable Objects prototype for Poneglyph. The existing Rust workspace and local backends remain unchanged. This is an experimental `0.1.0` package; the RFD remains Draft, and the Cloudflare implementation is not a released compatibility promise.

## Runtime layout and transaction visibility

Each graph uses one coordinator DO and four fixed entity-hash leaf DOs (`ROUTING_VERSION = 1`). A UTF-8 FNV-1a 64-bit hash of the canonical entity URI selects a leaf. The leaf count and version are part of deterministic DO names and are pinned in each object. There is no dynamic splitting or online rehash; changing this topology requires a future explicit migration. Graph IDs are lowercase slugs of at most 64 characters.

A non-empty batch is parsed before storage, capped at 1,000 facts and 1,000,000 canonical JSON bytes, and assigned one caller-provided `txId`. The coordinator retains a payload digest and terminal outcome: retrying the same `txId` and payload returns/resumes that outcome; reusing it with different content is a conflict. Facts are grouped by entity owner.

1. The coordinator durably reserves one graph writer and stores the transaction intent.
2. Every affected leaf prepares an idempotent staged payload. No active-fact or entity view changes during prepare. A permanent prepare rejection durably chooses abort and cancels every staged participant; transient failures remain recoverable.
3. After all prepares succeed, the coordinator records the irrevocable commit decision. Each leaf applies the append-only fact log, versioned active indexes, and versioned entity projection in one local SQLite transaction.
4. Only after every affected leaf acknowledges apply does the coordinator atomically advance the graph's `visible_seq` and mark the transaction complete. That watermark update is the all-or-nothing visibility point for the `txId`.

Readers do not lock the graph or wait on a cross-DO RPC. A query/entity read registers a short-lived lease at one `visible_seq` and passes that snapshot to every leaf. Versioned rows keep pre-commit state visible to an older in-flight query, even if some leaves have already applied the next sequence. Expired leases fail closed; obsolete projection/index versions are pruned below the oldest live snapshot. This is internal snapshot machinery, not a user-facing historical/as-of API. Writers serialize per graph; a competing write gets HTTP 423 with `Retry-After: 1`, while snapshot reads can continue.

Active facts are derived/replayable from the durable log. A retraction is appended and removes only the matching `(source, entity, field, value)` active assertion; retracting a tuple that is not active rejects and aborts the whole cross-leaf batch. Entity fields are a derived current view: assertions replace the field value; a retraction removes the current field only when its value matches. One entity is owned by one leaf, so its affected projection participates in the same local commit. A leaf rejects an entity with more than 10,000 active assertion tuples or 5,000 projected fields. This is a prototype bound for the unsplittable hot-entity case.

## API

The local Worker routes are:

```text
POST /v1/graphs/{graphId}/transactions
POST /v1/graphs/{graphId}/query        { "query": "..." }
GET  /v1/graphs/{graphId}/entities?uri=wiki%3Acrew%3Astraw-hats
```

Transaction JSON follows the Rust fact model:

```json
{
  "txId": "poneglyph:tx:batch-1",
  "facts": [{
    "source": "agent:wiki-import",
    "entity": "wiki:crew:straw-hats",
    "field": "wiki:crew:captain",
    "value": { "type": "reference", "value": "wiki:person:luffy" },
    "retraction": false
  }]
}
```

## Datalog subset and access paths

Queries are conjunctions of positive binary relations (`field(Entity, Value)`) and pure constraints. Terms are uppercase-leading variables, `_` in fact relations, URI/string constants, quoted strings, and signed 64-bit integer literals. Repeated variables unify. Top-level `FactValue::List` members are exposed as separate relation tuples, matching the existing Poneglyph/Datafox bridge. Supported constraints are `=`, `<`, `<=`, `>`, `>=`, `eq`, `lt`, `lte`, `gt`, `gte`, `before`, `after`, `contains`, `startsWith`, and `endsWith`. Builtin variables must be bound by a positive fact relation.

The parser rejects negation, recursive rules, non-binary relations, arbitrary expressions, unsupported builtins, unbound builtin variables, no-positive-relation queries, queries over 64 clauses, and query text over 8 KiB. There is no general-purpose optimizer: positive fact relations run in source order as a streaming nested-loop join, then constraints filter completed bindings. Each leaf emits NDJSON tuples; the coordinator fans out concurrently, merges the streams, and joins incrementally. The final JSON response is buffered only within explicit result/byte caps. Ordering is not promised.

| Bound terms in an atom | Leaf routing | SQLite access path |
| --- | --- | --- |
| field only | fan out to four leaves | `active_values_by_field_snapshot` |
| field + entity | route to the entity's leaf | `active_values_by_field_entity_snapshot` |
| field + value | fan out to four leaves | `active_values_by_field_value_snapshot` |
| field + entity + value | route to entity's leaf | `active_values_by_field_entity_value_snapshot` |

A bound value uses the current Poneglyph/Datafox conversion rule: integer literals map to numeric facts; URI-looking strings map to references except in `wiki:page:title` and `schema:name`; other strings map to text. Unbound-entity scans are proportional to all four leaves plus matching rows. A value constraint alone does not route to one leaf. Query responses include the snapshot and scan/fan-out/tuple/byte counters.

Fixed prototype budgets: 2,000 results, 50,000 streamed tuples, 20,000 shard requests, 20,000,000 scanned response bytes, 2,000,000 serialized result bytes, 20 seconds per query, and 128 concurrent read leases. A result/scan budget failure returns an error rather than silently truncating output.

## Local checks

Requires Node.js and pnpm. The Cloudflare Vitest plugin executes Worker and SQLite DO tests in local workerd; tests use unique graph IDs and create no account resources.

```sh
cd cloudflare
pnpm install
pnpm check
pnpm exec wrangler types
```

The checked-in compatibility date is `2026-09-30` because the pinned local workerd build does not support later dates yet. Update the Cloudflare toolchain/date together before deployment. Do not deploy until the full local transaction/recovery and One Piece load/query gates pass.
