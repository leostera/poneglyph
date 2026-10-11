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

FokosDB's public design/code study informed the DO-local routing and shard-boundary tradeoff recorded in [RFD0003](../docs/rfds/RFD0003-cloudflare-native-graph-database.md). Poneglyph uses four fixed entity-hash leaves and a transaction coordinator for this checkpoint; it does not copy FokosDB's data model or attempt dynamic splitting.

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

## One Piece local load/query workload

The repeatable offline harness imports MediaWiki XML from the One Piece Fandom current dump into a temporary local `cf dev`/workerd instance, then runs the same four representative queries as the Rust stress workload. The runnable harnesses live at repository-level `examples/onepiece-load.ts` and `examples/deployed-smoke.ts`; the package scripts below are their convenience entrypoints. `cf dev` uses the Cloudflare Vite plugin and the project’s `cloudflare.config.ts`; the harness discovers the local Vite URL announced at startup. It streams XML parsing and bounds writes at 500 facts / 800,000 estimated fact bytes per transaction; the Worker still enforces the canonical 1 MB transaction cap. Domain relationship facts for crews/islands/lore are the deterministic test fixture layered on top of real page-derived title/category/link facts; this is a workload, not a wiki connector. A unique graph ID and temporary SQLite persistence directory are used each run; the `cf dev` process is stopped and its temporary state removed afterward. The downloaded dump cache is kept for reuse. No Cloudflare account resources are created.

```sh
# from the repository root; the dump/cache is ignored by git
PONEGLYPH_ONEPIECE_DUMP_SHA256=c4e33cc6793425d9baa5f76a9f12f047d75dec135006093ed9357629a7d1f7bb \
  ./tests/fixtures/download_onepiece_fandom.sh
cd poneglyph
PONEGLYPH_ONEPIECE_MAX_PAGES=20000 PONEGLYPH_ONEPIECE_QUERIES=10 pnpm test:onepiece
```

`PONEGLYPH_ONEPIECE_XML` overrides the XML path. `PONEGLYPH_ONEPIECE_ARCHIVE` can name its corresponding archive for hash reporting. Page limit defaults to 5,000; set it to `0` to attempt the full dump. The script prints XML/archive SHA-256 values, page/fact/transaction counts, load rate, query access metrics, and warm median/p95 latency. The dump's `current` URL can change; the optional checksum makes that drift explicit. The source `.7z` and extracted XML are not checked in.

Recorded local run after the `cf` CLI/Vite migration and examples relocation (2026-10-11, Apple M4 Pro, 12 CPU cores, Node 26.11.0, pnpm 12.10.1; timings are local workerd, not production Cloudflare):

- Toolchain: `cf@1.0.0-beta.14`, `@cloudflare/vite-plugin@2.0.0-beta.sha-91c870c02`, Vite 8.3.4, and compatibility date `2026-10-06` (`workerd@1.20261006.1`).
- Input: 20,000-page prefix of a 436,781,838-byte XML dump (`1446ff8fca4bdebd289e5a546d67078d1170369fb3bfb65a35c758d53cd4e084`); archive SHA-256 `c4e33cc6793425d9baa5f76a9f12f047d75dec135006093ed9357629a7d1f7bb`.
- Load: 159,332 facts in 320 atomic transactions, 138.39 s elapsed (about 1,151 facts/s). The harness checked each returned `commitSeq` and verified all four queries and their replays used snapshot sequence 320.

| Query | Rows | Scan calls | Shard requests | Tuples | Stream bytes | Warm median / p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| captains and seconds (5 clauses) | 12 | 34 | 37 | 45 | 4,533 | 109.78 / 151.70 ms |
| islands and leaders (3 clauses) | 7 | 15 | 18 | 21 | 2,071 | 83.57 / 92.15 ms |
| Joy Boy-to-Luffy chain (6 clauses) | 1 | 12 | 15 | 12 | 1,245 | 72.29 / 92.99 ms |
| character names containing ` D. ` (2 clauses + builtin) | 9 | 669 | 672 | 1,346 | 116,018 | 1,375.90 / 1,853.12 ms |

The multi-hop queries are coordinator nested-loop joins over streamed DO-local scans. The first unbound atom fans out to all four leaves; later entity-bound atoms route to one leaf, visible in request counts. The high scan count for the D-name query shows the prototype's cost: it does not reorder predicates or perform a global text index. The captain query can return more than the six synthetic crews because the inherited ASCII slugger is not injective over all real wiki titles; that fixture behavior is not a production identity strategy. Query order and wall-clock values are not stability promises.

## Local setup and checks

Requires Node.js 26 and pnpm 12. `cloudflare.config.ts` is the sole Cloudflare deployment/runtime configuration. `vite.config.ts` registers the Cloudflare Vite plugin; `vitest.config.ts` contains local test-runner options for Miniflare/SQLite DOs and does not load a Wrangler config. The Cloudflare Vitest plugin executes Worker and SQLite DO tests in local workerd; tests use unique graph IDs and create no account resources.

```sh
cd poneglyph
pnpm install
pnpm check          # cf workers types, strict TypeScript, and all Vitest tests
pnpm build          # type generation/typecheck plus cf build
pnpm exec cf deploy --dry-run
pnpm dev            # local Vite/workerd server
```

The compatibility date is `2026-10-06`; generated local types identify `workerd@1.20261006.1`. Keep the `cf` CLI, Cloudflare Vite plugin, and compatibility date aligned. The `cf` CLI currently delegates production bundling to Vite. Wrangler is not a project configuration or direct package dependency; the Cloudflare test plugin may retain internal tooling dependencies. Do not deploy until strict typecheck, unit/integration transaction/recovery tests, the One Piece load/query workload, and both normal/cleanup dry runs pass.

## Isolated Cloudflare validation and cleanup

The temporary validation deployment is intentionally isolated:

- Worker: `poneglyph-cloudflare-checkpoint-20261011`.
- Custom domain: `poneglyph-checkpoint-20261011.poneglyph.leostera.dev` (under the requested `*.poneglyph.leostera.dev` namespace).
- `workersDev` is disabled. The public endpoint is only the configured custom domain.
- Bindings create only the `GraphCoordinatorDO` and `GraphShardDO` SQLite namespaces under that Worker. No other existing account resources should be changed.

Authenticate with `cf auth whoami`, then inspect the exact Worker name and hostname for collisions before deployment. The exact Worker name and DNS hostname were both absent before this validation. Run local gates first; then from `poneglyph/`:

```sh
pnpm deploy
pnpm test:deployed
```

`pnpm test:deployed` enforces HTTPS within `*.poneglyph.leostera.dev`, writes four facts whose entities hash to all four leaves, retries the same `txId` and payload, then runs a distributed Datalog query and checks its snapshot equals the commit sequence. It prints the graph/transaction IDs, fan-out counters, and query result count. It is a small deployment smoke/load validation, not a production throughput claim. Set `PONEGLYPH_CLOUDFLARE_URL` only to another isolated host in that test namespace.

Recorded deployed validation (2026-10-11): the Worker committed four facts spanning leaves 0–3 at `commitSeq = 1`; replaying the same `txId` returned the committed result; the distributed query returned four rows at `snapshotSeq = 1` with four shard requests, four tuples, and 420 stream bytes. The Worker was reachable only through the configured custom domain; `workers.dev` was disabled. Afterward, cleanup reported both DO exports deleted, `cf workers delete` removed the dedicated Worker and custom domain/DNS entry, and final exact-name listings for the Worker, DNS record, and generated Advanced Certificate pack were all empty.

After recording results, retire only this validation deployment. **The cleanup mode is destructive for these two Durable Object classes and permanently deletes their namespace data**, including the smoke-test graph. Deploy cleanup mode first to retire those classes, then delete the dedicated Worker script. The `cf workers delete` command removes its custom domain and Worker-managed DNS record. It may also mark the generated Advanced Certificate pack for asynchronous deletion, so verify that the matching pack disappears before considering cleanup complete:

```sh
pnpm exec cf deploy --mode cleanup
WORKER_ID=$(cf workers list --per-page 100 | jq -r '.[] | select(.name == "poneglyph-cloudflare-checkpoint-20261011") | .id')
test -n "$WORKER_ID" && cf workers delete "$WORKER_ID" --force
cf dns records list --zone leostera.dev --name poneglyph-checkpoint-20261011.poneglyph.leostera.dev
cf workers list --per-page 100 | jq '.[] | select(.name == "poneglyph-cloudflare-checkpoint-20261011")'
cf ssl certificate-packs list --zone leostera.dev --status all --per-page 100 | jq '[.[] | select((.hosts // [] | tostring | contains("poneglyph-checkpoint-20261011.poneglyph.leostera.dev")))]'
```

Confirm the DNS, Worker, and matching certificate-pack listings all return `[]`/no match. The cleanup mode and delete command must target only this dedicated Worker and its namespaces. Do not manually edit unrelated DNS records or certificate packs. If cleanup fails, stop and inspect the isolated Worker before retrying.

## Checkpoint readiness criteria

This branch is a reliable experimental checkpoint—not a production-ready service—because the following gates were completed together:

- The existing Rust/local workspace stayed intact; formatting, workspace tests, and strict Clippy passed during the checkpoint.
- `pnpm check` passes strict TypeScript generation/typecheck plus all 18 Cloudflare Vitest tests, including cross-leaf commit visibility, partial-apply recovery, idempotent retry/conflict handling, and abort on invalid retraction. `pnpm build` and normal/cleanup `cf deploy --dry-run` both pass.
- The checksum-pinned 20,000-page One Piece workload commits 159,332 facts in 320 transactions and passes all four multi-DO queries/replays at sequence 320.
- The isolated Cloudflare custom-domain smoke run proves a four-leaf transaction, `txId` replay, and query snapshot visibility; every validation Worker/DO namespace/domain/DNS/certificate resource was then removed.

The checkpoint stays Draft until a later RFD revises the scope. Historical/as-of queries, schema evolution, global replication, ingestion connectors, dynamic shard splitting, hot-entity splitting, and a general-purpose distributed optimizer remain explicitly out of scope.
