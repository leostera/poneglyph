# Poneglyph Worker prototype operations

Strict TypeScript package and Cloudflare Workers/Durable Objects prototype for Poneglyph. The earlier Rust workspace and local backends were removed from this branch only; their commits remain in Git history and other branches are unchanged. This is an experimental `0.1.0` package; RFD0003/RFD0004 remain Draft, and the Cloudflare implementation is not a released compatibility promise.

## Runtime layout and transaction visibility

Each graph uses one `GraphCoordinatorDO` and a sparse tree of `GraphShardDO` instances. A stable SHA-256 key over `(graphId, canonicalEntityUri)` selects a 256-bit virtual range; deterministic object names encode the range prefix rather than a physical shard count. A leaf can be split into two children and becomes a router; future splits recurse. No application-level maximum leaf count is configured, though Cloudflare quotas, the per-DO byte cap, query fan-out, hash depth, and one-entity locality remain hard limits. Graph IDs are lowercase slugs of at most 64 characters.

A non-empty batch is parsed before storage, capped at 1,000 facts and 1,000,000 canonical JSON bytes, and assigned one caller-provided `txId`. The coordinator retains a payload digest and terminal outcome for seven days (bounded at 100,000 outcomes): retrying the same `txId` and payload returns/resumes that outcome; reusing it with different content is a conflict during that window. Append-only fact IDs include the commit sequence and batch index, so a `txId` may be reused after its outcome expires without colliding with prior fact-log rows. Facts are grouped by entity owner.

Coordinator and shard SQLite schemas initialize atomically and record a schema-kind/version marker. An unversioned or mismatched existing namespace is rejected before application DDL runs; the fixed-leaf checkpoint is not automatically upgraded or imported. The current deployment uses a fresh, isolated Worker/DO namespace and fresh graph IDs. This is a fail-closed guard, not a general schema migration system; schema evolution and importing old graph data remain out of scope.

1. The coordinator durably reserves one graph writer and stores the transaction intent.
2. Every affected leaf prepares an idempotent staged payload. No active-fact or entity view changes during prepare. A permanent prepare rejection durably chooses abort and cancels every staged participant; transient failures remain recoverable.
3. After all prepares succeed, the coordinator records the irrevocable commit decision. Each leaf applies the append-only fact log, versioned active indexes, and versioned entity projection in one local SQLite transaction.
4. Only after every affected leaf acknowledges apply does the coordinator atomically advance the graph's `visible_seq` and mark the transaction complete. That watermark update is the all-or-nothing visibility point for the `txId`.

Readers do not lock graph writes. A query/entity read registers a short-lived lease containing `{visible_seq, directory_epoch}` and resolves every leaf against that same pair. Versioned rows keep pre-commit state visible while participants apply; directory epochs keep reads on the source or the copied children without mixing owners. During a split, the graph coordinator durably pauses all writes (reads continue); after cutover, old owners remain readable until leases on their epoch drain, then are retired. Expired leases fail closed; obsolete projection/index versions are pruned below the oldest live snapshot. This is internal snapshot machinery, not a user-facing historical/as-of API. Ordinary writers serialize per graph; a competing write gets HTTP 423 with `Retry-After: 1`. Every client using the same graph ID reaches the same coordinator, so more clients do not increase per-graph write capacity. Cloudflare documents approximately 1,000 requests/second per DO as a soft, workload-dependent limit, not a guaranteed rate or hard ceiling; Poneglyph's per-graph write rate requires workload-specific measurement. Sharding scales data placement and scan fan-out, not commit sequencing.

FokosDB's public design/code study informed the DO-local routing and shard-boundary tradeoff recorded in [RFD0003](../docs/rfds/RFD0003-cloudflare-native-graph-database.md). Poneglyph does not copy FokosDB's data model. The current prefix directory and migration protocol are specified and measured separately in [RFD0004](../docs/rfds/RFD0004-expandable-cloudflare-sharding.md).

Active facts are derived/replayable from the durable log. A retraction is appended and removes only the matching `(source, entity, field, value)` active assertion; retracting a tuple that is not active rejects and aborts the whole cross-leaf batch. Entity fields are a derived current view: assertions replace the field value; a retraction removes the current field only when its value matches. One entity is owned by one leaf, so its affected projection participates in the same local commit. A leaf rejects an entity with more than 10,000 active assertion tuples or 5,000 projected fields. This is a prototype bound for the unsplittable hot-entity case.

## API

The local Worker routes are:

```text
POST /v1/graphs/{graphId}/transactions
POST /v1/graphs/{graphId}/query        { "query": "..." }
GET  /v1/graphs/{graphId}/entities?uri=wiki%3Acrew%3Astraw-hats
```

Transaction JSON uses the typed Poneglyph fact shape:

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

## Authenticated reactive TODO example

`GET /todo` serves the shared TODO UI. Set `TODO_SHARED_PASSPHRASE` as a Cloudflare Worker secret (never as a checked-in variable):

```sh
# Generate a high-entropy phrase in this shell; do not echo it, save it, or commit it.
export PONEGLYPH_TODO_PASSPHRASE="$(openssl rand -hex 32)"
pnpm exec cf workers secrets update TODO_SHARED_PASSPHRASE \
  --worker poneglyph-scaleout-validation-20261011 \
  --type secret_text --text "$PONEGLYPH_TODO_PASSPHRASE"
# Keep the environment value only while running the authenticated smoke/benchmark.
# Unset it and delete the temporary Worker after validation.
```

The Worker fails closed when the secret is absent. Login accepts the passphrase over HTTPS, compares bounded SHA-256 digests without an early-exit byte comparison, then issues a one-hour HMAC-signed `Secure; HttpOnly; SameSite=Strict` cookie. The passphrase is not embedded in the page, stored in a Durable Object, or sent in the WebSocket URL. Protected TODO HTTP routes and the direct `/v1/graphs/todo-shared-2026/...` read API require the signed session; writes to that graph through the generic transaction route are denied so mutations cannot bypass notifications. WebSocket handshakes require the cookie and exact same-origin HTTPS `Origin` (loopback HTTP is allowed for local development).

The two list entities (`todo:list:todo`, `todo:list:done`) are routed to opposite root-prefix children for the fixed demo graph. Moving a task is one `txId` containing retractions for the old task/list membership and assertions for the task's new list and destination membership. The coordinator advances `visible_seq` only after all participants apply; the Worker sends an invalidation to the hibernatable `TodoHubDO` only after receiving that committed outcome. Clients then re-query a pinned snapshot. The local integration test connects two clients, performs a cross-leaf move, checks the transaction participant count is two, and verifies each notification's sequence is query-visible. WebSocket delivery is best-effort (there is no durable notification outbox); errors are logged, and clients refresh on reconnect. A missed invalidation does not roll back committed facts.

For local development, use a throwaway passphrase in `.dev.vars` (ignored by Git) or the local runtime's secret binding, then open `/todo`. Do not copy the test-only passphrase from `vitest.config.ts` into a deployed Worker.

## Datalog subset and access paths

Queries are conjunctions of positive binary relations (`field(Entity, Value)`) and pure constraints. Terms are uppercase-leading variables, `_` in fact relations, URI/string constants, quoted strings, and signed 64-bit integer literals. Repeated variables unify. Top-level `FactValue::List` members are exposed as separate relation tuples, matching the existing Poneglyph/Datafox bridge. Supported constraints are `=`, `<`, `<=`, `>`, `>=`, `eq`, `lt`, `lte`, `gt`, `gte`, `before`, `after`, `contains`, `startsWith`, and `endsWith`. Builtin variables must be bound by a positive fact relation.

The parser rejects negation, recursive rules, non-binary relations, arbitrary expressions, unsupported builtins, unbound builtin variables, no-positive-relation queries, queries over 64 clauses, and query text over 8 KiB. There is no general-purpose optimizer: positive fact relations run in source order as a streaming nested-loop join, then constraints filter completed bindings. Each leaf emits NDJSON tuples; the coordinator fans out concurrently, merges the streams, and joins incrementally. The final JSON response is buffered only within explicit result/byte caps. Ordering is not promised.

| Bound terms in an atom | Leaf routing | SQLite access path |
| --- | --- | --- |
| field only | fan out to every active leaf (max 256) | `active_values_by_field_snapshot` |
| field + entity | resolve one leaf through prefix routers | `active_values_by_field_entity_snapshot` |
| field + value | fan out to every active leaf (max 256) | `active_values_by_field_value_snapshot` |
| field + entity + value | resolve entity's leaf | `active_values_by_field_entity_value_snapshot` |

A bound value uses the current Poneglyph/Datafox conversion rule: integer literals map to numeric facts; URI-looking strings map to references except in `wiki:page:title` and `schema:name`; other strings map to text. Unbound-entity scans are proportional to every active leaf (bounded at 256) plus matching rows. A value constraint alone does not route to one leaf. Query responses include the snapshot and scan/fan-out/tuple/byte counters.

Prototype budgets: 2,000 results, 50,000 streamed tuples, 20,000 shard requests, 20,000,000 scanned response bytes, 2,000,000 serialized result bytes, 20 seconds per query, 128 concurrent read leases, 256 leaf fan-out, and 511 directory-node visits per broad query. Transactions are limited to 32 participant leaves and at most eight automatic splits during preflight. A result/scan budget failure returns an error rather than silently truncating output.

## Local repeatable throughput/query benchmark

`pnpm bench:local` runs the same bounded Miniflare/workerd benchmark against one unsplit leaf and a graph split at the root. Defaults are 40 transactions per topology, three facts and two entities per transaction, 40 query requests per topology (20 each of a full scan and a join), and concurrency four. Writes retry the same `txId`/payload after retryable busy responses; reported transaction latency includes retry/backoff. It emits JSON with transactions/facts/entities per second, QPS, p50/p95/p99, shard/scan/tuple/byte/directory counters. Override `PONEGLYPH_BENCH_TRANSACTIONS`, `PONEGLYPH_BENCH_QUERIES`, and `PONEGLYPH_BENCH_CONCURRENCY` within the script's explicit bounds.

Recorded local sample (2026-10-11, local workerd, 40 transactions / topology, three facts and two entities per transaction, concurrency four; one run, noisy and not a production claim):

| Topology / shape | Writes: tx/s, facts/s, entities/s | Write p50/p95/p99 ms | Query QPS | Query p50/p95/p99 ms | Scan/shard/tuple/byte/directory costs |
| --- | --- | --- | ---: | --- | --- |
| single leaf | 87.34 / 262.01 / 174.67 | 17 / 165 / 227 | — | — | — |
| single leaf full scan | — | — | 30.49 | 9 / 23 / 24 | 1 scan / 1 shard / 80 tuples / 6,320 bytes / 1 directory request |
| single leaf join | — | — | 30.49 | 116 / 130 / 131 | 41 scans / 41 shard requests / 80 tuples / 6,840 bytes / 41 directory requests |
| two leaves | 85.29 / 255.86 / 170.58 | 27 / 101 / 198 | — | — | — |
| two leaves full scan | — | — | 25.87 | 13 / 15 / 18 | 1 scan / 2 shards / 80 tuples / 6,241 bytes / 3 directory requests |
| two leaves join | — | — | 25.87 | 134 / 153 / 154 | 41 scans / 42 shard requests / 124 tuples / 10,185 bytes / 55 directory requests |

A relation join currently drives repeated source-order scans rather than a cost-based plan; the high scan/directory counts are visible costs, not hidden by response latency. These samples use tiny synthetic data in one local process and are not directly comparable to the real-data workload below.

## One Piece local load/query workload

The repeatable offline harness imports MediaWiki XML from the One Piece Fandom current dump into a temporary local `cf dev`/workerd instance, then runs four representative graph queries defined for the Cloudflare checkpoint. The runnable harnesses live at repository-level `examples/onepiece-load.ts` and `examples/deployed-smoke.ts`; the package scripts below are their convenience entrypoints. `cf dev` uses the Cloudflare Vite plugin and the project’s `cloudflare.config.ts`; the harness discovers the local Vite URL announced at startup. It streams XML parsing and bounds writes at 500 facts / 800,000 estimated fact bytes per transaction; the Worker still enforces the canonical 1 MB transaction cap. Domain relationship facts for crews/islands/lore are the deterministic test fixture layered on top of real page-derived title/category/link facts; this is a workload, not a wiki connector. A unique graph ID and temporary SQLite persistence directory are used each run; the `cf dev` process is stopped and its temporary state removed afterward. The downloaded dump cache is kept for reuse. No Cloudflare account resources are created.

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
- Current expandable implementation load: 159,332 facts in 320 atomic transactions, 618.19 s elapsed (about 257.74 facts/s). This is substantially slower than the historical fixed-leaf checkpoint and is recorded as a limitation rather than hidden. The harness checked each returned `commitSeq` and verified all four queries and replays used snapshot sequence 320. No physical database-size measurement was captured; the bounded fixture is 159k facts and was removed with its temporary `cf dev` directory.

| Query | Rows | Scan calls | Shard requests | Tuples | Stream bytes | Directory requests | Warm median / p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| captains and seconds (5 clauses) | 12 | 34 | 34 | 45 | 4,533 | 19 | 133.73 / 184.75 ms |
| islands and leaders (3 clauses) | 7 | 15 | 15 | 21 | 2,071 | 15 | 102.21 / 109.45 ms |
| Joy Boy-to-Luffy chain (6 clauses) | 1 | 12 | 12 | 12 | 1,245 | 6 | 88.21 / 130.94 ms |
| character names containing ` D. ` (2 clauses + builtin) | 9 | 669 | 669 | 1,346 | 116,018 | 669 | 2,302.69 / 3,073.49 ms |

The multi-hop queries are coordinator nested-loop joins over streamed DO-local scans. A field-only atom fans out to all active leaves (at most 256); entity-bound atoms follow the prefix directory to one leaf, visible in request and directory-hop metrics. The high scan count for the D-name query shows the prototype's cost: it does not reorder predicates or perform a global text index. The captain query can return more than the six synthetic crews because the inherited ASCII slugger is not injective over all real wiki titles; that fixture behavior is not a production identity strategy. Query order and wall-clock values are not stability promises.

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

## Current expandable-topology Cloudflare validation and cleanup

After the local gates above passed, one bounded run used only the isolated Worker and hostname configured for this package:

- Worker: `poneglyph-scaleout-validation-20261011`.
- Custom domain: `poneglyph-scaleout-20261011.poneglyph.leostera.dev`; `workersDev` is disabled.
- Durable Object classes: `GraphCoordinatorDO`, `GraphShardDO`, and `TodoHubDO` under that Worker only.
- The Worker name, hostname, matching DNS record, and matching certificate pack were absent before deployment. A 256-bit random TODO passphrase was sent as the `TODO_SHARED_PASSPHRASE` Worker secret; the value was held only in the validation shell environment for the smoke/benchmark and was never printed or committed.

Once its automatically-created certificate became active, `pnpm test:deployed:todo` verified: the page was served; unauthenticated HTTP, a bad passphrase, and an unauthenticated WebSocket were each rejected with 401; two authenticated live clients received the same invalidation for a move between two shard participants; and a re-query at that `commitSeq` showed only the destination list. The measured smoke moved task membership atomically at `commitSeq = 6` (the shared graph already had earlier smoke transactions, so it began at snapshot 4). This is post-commit invalidation evidence, not durable notification delivery: the hub remains best-effort with no outbox.

The measured Cloudflare benchmark workloads were 10 single-shard transactions (3 facts / 2 entities each) and 10 cross-shard TODO moves (4 facts / 3 touched entities each), with concurrency 2 and 10 query requests per topology (five per shape). The TODO benchmark also created 10 seed tasks before timing the moves; its final snapshot had 13 tasks at sequence 26, including three created by earlier smoke invocations. This used one temporary Worker and a few Durable Objects, far below any capacity limit.

| Workload | Transactions / transaction contents | Concurrency | Elapsed | tx/s | facts/s | entities/s | Write p50 / p95 / p99 ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| single-shard graph | 10 transactions; 3 facts and 2 entities each | 2 | 2.93 s | 3.41 | 10.24 | 6.83 | 566.76 / 1,358.45 / 1,358.45 |
| cross-shard TODO move | 10 transactions; 4 facts and 3 touched entities each, 2 participants | 2 | 4.10 s | 2.44 | 9.77 | 7.32 | 383.13 / 2,522.48 / 2,522.48 |

| Query topology / shape | Requests | QPS | p50 / p95 / p99 ms | Scan / shard / tuple / byte / directory requests |
| --- | ---: | ---: | --- | --- |
| single-shard full scan | 5 | 3.95 | 131.77 / 138.95 / 138.95 | 1 / 1 / 20 / 1,630 / 1 |
| single-shard join | 5 | 3.95 | 338.13 / 381.36 / 381.36 | 11 / 11 / 20 / 1,800 / 11 |
| TODO membership scan (2 leaves) | 5 | 2.43 | 166.03 / 188.33 / 188.33 | 1 / 2 / 13 / 1,443 / 3 |
| TODO task join (2 leaves) | 5 | 2.43 | 518.79 / 716.13 / 716.13 | 14 / 15 / 26 / 2,988 / 29 |

The Cloudflare smoke also verified a four-fact generic transaction, same-`txId` replay, and a four-row query at snapshot sequence 1. Each query shape above has only five latency samples, so p95/p99 collapse to the observed maximum and are not meaningful tail-latency estimates. The run includes public-network and Worker/DO overhead; it is not an SLA, capacity calibration, or a production load test. It did not capture individual DO database sizes, account storage metrics, CPU duration, or a physical capacity estimate. The 1 TB result remains synthetic only. After this account run, schema initialization gained an atomic version marker and fail-closed guard for unversioned namespaces; that startup-only change passed local workerd tests/build but was not redeployed to Cloudflare. Transaction, migration, and query data paths were unchanged.

The visible account subscription list showed an existing `Workers Paid` plan at $5/month before and after this run; it was not created by the validation. The account subscription count remained 21. Billing-history and usage API reads returned HTTP 403 under the available CLI authentication, so incremental metered usage/charges could not be inspected. This is not evidence of zero usage charges. No additional subscription was added.

Cleanup ran `pnpm exec cf deploy --mode cleanup`, which deleted all three DO class namespaces, then `cf workers delete poneglyph-scaleout-validation-20261011 --force`. Final targeted listings were empty for the Worker script, its DO namespaces, the Worker-managed DNS record, and the matching certificate pack. The certificate pack passed through `pending_deletion` and disappeared asynchronously; public DNS queries for the hostname and validation TXT records also returned no records. Deleting the Worker removed its bound passphrase secret. No unrelated Worker, DNS record, or certificate pack was changed.

To repeat the bounded check after local gates pass, keep the phrase only in the active shell while setting the Cloudflare secret and invoking the tests; do not print or save it:

```sh
cd poneglyph
pnpm deploy
export PONEGLYPH_TODO_PASSPHRASE="$(openssl rand -hex 32)"
pnpm exec cf workers secrets update TODO_SHARED_PASSPHRASE \
  --worker poneglyph-scaleout-validation-20261011 \
  --type secret_text --text "$PONEGLYPH_TODO_PASSPHRASE"
# Allow the secret version to propagate before the smoke tests.
sleep 20
pnpm test:deployed:todo
PONEGLYPH_CLOUDFLARE_TRANSACTIONS=10 \
PONEGLYPH_CLOUDFLARE_QUERIES=10 \
PONEGLYPH_CLOUDFLARE_CONCURRENCY=2 pnpm bench:cloudflare
pnpm test:deployed
unset PONEGLYPH_TODO_PASSPHRASE
pnpm exec cf deploy --mode cleanup
pnpm exec cf workers delete poneglyph-scaleout-validation-20261011 --force
```

Verify cleanup with exact-name filters (the secret-list call should return Worker-not-found because deleting the script removes the binding):

```sh
pnpm exec cf workers scripts search --name poneglyph-scaleout-validation-20261011 --per-page 100
pnpm exec cf durable-objects namespaces list --per-page 100 | jq '[.[] | select((.script // "") == "poneglyph-scaleout-validation-20261011")]'
pnpm exec cf dns records list --zone leostera.dev --name poneglyph-scaleout-20261011.poneglyph.leostera.dev --per-page 20
pnpm exec cf ssl certificate-packs list --zone leostera.dev --status all --per-page 100 | jq '[.[] | select((.hosts // [] | tostring | contains("poneglyph-scaleout-20261011.poneglyph.leostera.dev")))]'
pnpm exec cf workers secrets list --worker poneglyph-scaleout-validation-20261011
```

The Worker script, namespace filter, DNS list, and certificate-pack filter must return no matches; the final secret query may return HTTP 404 because the Worker no longer exists. The Worker deletion is intentionally last because cleanup mode permanently removes the three namespace databases. Custom-domain certificate issuance and deletion are asynchronous; wait for status `active` before HTTPS tests and for the matching pack to disappear after deletion.

## Historical fixed-leaf Cloudflare validation and cleanup

The earlier fixed-leaf checkpoint deployment was intentionally isolated:

- Worker: `poneglyph-cloudflare-checkpoint-20261011`.
- Custom domain: `poneglyph-checkpoint-20261011.poneglyph.leostera.dev` (under the requested `*.poneglyph.leostera.dev` namespace).
- `workersDev` is disabled. The public endpoint is only the configured custom domain.
- Bindings create only the `GraphCoordinatorDO` and `GraphShardDO` SQLite namespaces under that Worker. No other existing account resources should be changed.

Authenticate with `cf auth whoami`, then inspect the exact Worker name and hostname for collisions before deployment. The exact Worker name and DNS hostname were both absent before this validation. Run local gates first; then from `poneglyph/`:

```sh
pnpm deploy
pnpm test:deployed
```

`pnpm test:deployed` enforces HTTPS within `*.poneglyph.leostera.dev`, writes four facts to a fresh expandable graph, retries the same `txId` and payload, then runs a distributed Datalog query and checks its snapshot equals the commit sequence. It prints the graph/transaction IDs, fan-out counters, and query result count. It is a small deployment smoke validation, not a production throughput claim. Set `PONEGLYPH_CLOUDFLARE_URL` only to another isolated host in that test namespace.

Historical deployed checkpoint validation (2026-10-11, fixed four-leaf version): the Worker committed four facts spanning leaves 0–3 at `commitSeq = 1`; replaying the same `txId` returned the committed result; the query returned four rows at `snapshotSeq = 1`. The Worker was reachable only through its custom domain; `workers.dev` was disabled. Cleanup deleted its DO namespaces, Worker, custom domain/DNS entry, and generated certificate pack. This does not validate the current expandable topology; the separate bounded run above is the relevant current deployment evidence.

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

## Historical fixed-leaf checkpoint

The earlier checkpoint commit `521ff54` established transaction visibility with four fixed hash leaves. Its old isolated Cloudflare smoke and four-leaf measurements predate prefix routing; they are historical only and are not evidence for the expandable topology documented above. The Rust workspace was removed from this branch in `f460f1d`; commits and other branches were left intact.

## Remaining limits

This is an experimental prototype, not a released compatibility promise. The 1 TB result is synthetic byte accounting over 10,000 virtual keys and writes zero synthetic payload rows; small local integration tests exercise real fact copy/cutover/recovery separately. The 8 GB limit is a conservative accounted-byte admission policy, not an empirically proven physical database-size cap. The bounded Cloudflare run did not capture per-DO physical database sizes or itemized billing usage.

The split protocol pauses all graph writes during copy, retains transaction outcomes for seven days (up to 100,000 per graph), and can reject an unsplittable hot entity/hash range. A graph still has one serialized coordinator, queries fan out to at most 256 leaves, transactions use at most 32 participants, and Cloudflare quotas/costs are account-specific. TODO invalidations are best-effort with no durable outbox. The schema marker rejects unversioned or incompatible SQLite namespaces; automatic schema evolution/import from the fixed-leaf checkpoint is not implemented. Historical/as-of queries, global replication, ingestion connectors, and a general-purpose distributed optimizer remain out of scope.
