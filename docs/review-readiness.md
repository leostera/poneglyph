# Review Readiness

This branch contains an experimental TypeScript Poneglyph implementation for Cloudflare Workers and SQLite-backed Durable Objects. Expandable prefix routing, split/cutover recovery, capacity admission, the authenticated TODO demo, local benchmark harnesses, and one bounded isolated Cloudflare validation have been implemented. Detailed methodology and results are in [`poneglyph/OPERATIONS.md`](../poneglyph/OPERATIONS.md) and the architecture contract is in [RFD0004](rfds/RFD0004-expandable-cloudflare-sharding.md).

The earlier Rust workspace was removed from this branch only; its commits and other branches remain unchanged. RFD0003/RFD0004 are design records, not a released compatibility promise. The earlier fixed-four-leaf Cloudflare run is historical and is not evidence for expandable routing.

## Verification record

Latest local gates (2026-10-11):

- `cd poneglyph && pnpm check`: strict TypeScript/type generation passed; 28 tests passed, one optional benchmark test skipped by default.
- `pnpm bench:local`: explicit benchmark passed with 40 transactions per topology, 3 facts / 2 entities per transaction, 40 queries per topology, concurrency 4. It reports transaction/fact/entity throughput, query QPS and p50/p95/p99, and scan/shard/tuple/byte/directory costs; full output is recorded in the package README.
- `pnpm test:capacity`: 10,000 synthetic entities total 1 TB logical bytes, 271 leaves, 270 routers, maximum depth 9, largest leaf 4.9 GB, maximum accounted leaf 7.39 GB, zero synthetic rows/payload bytes written.
- The checksum-pinned 20,000-page One Piece local run committed 159,332 facts in 320 transactions (618.19 s, approximately 257.74 facts/s) and passed four representative queries/replays at snapshot sequence 320. This is local workerd evidence only.
- `pnpm build`, normal/cleanup deploy dry-runs, and the PlusCal/TLC checks have passed. The bounded formal models are design checks, not proofs of implementation correctness.

The isolated Cloudflare run used Worker `poneglyph-scaleout-validation-20261011` and `poneglyph-scaleout-20261011.poneglyph.leostera.dev` only. The authenticated demo verified HTTP and WebSocket rejection, a two-participant cross-shard task move, matching invalidations for two authenticated clients, and re-query at the committed sequence. The bounded benchmark used 10 transactions per topology, concurrency 2, and 10 query requests per topology. It measured 3.41 single-shard tx/s and 2.44 cross-shard TODO moves/s; exact query/write percentiles and costs are in the package README. Five query samples per shape make p95/p99 the observed maximum, not meaningful tail estimates. This public-network sample is not an SLA or capacity claim. A startup-only schema-kind/version marker and fail-closed guard was added after the account run; it passed local workerd tests/build but was not redeployed. The measured transaction/query paths were unchanged.

Cleanup deployed the class-deletion mode, deleted the temporary Worker, and verified no matching Worker script, DO namespaces, DNS record, secret, or certificate pack remained. The certificate pack disappeared asynchronously after `pending_deletion`. The visible account subscription list had an existing `Workers Paid` subscription at $5/month and 21 subscriptions both before and after. Billing-history and usage API reads returned HTTP 403 under the available CLI authentication; do not claim that incremental metered usage was zero. No additional subscription was created.

## Review invariants and compatibility

- Facts/retractions are append-only; active facts, indexes, and entity projections are derived/replayable.
- A transaction becomes visible only when the coordinator publishes its sequence after every participant applies.
- Reads pin one snapshot sequence and directory epoch. The source remains authoritative until directory cutover; old owners stay available until old-epoch leases drain.
- A split pauses graph writes, copies bounded pages with idempotent receipts/digests, verifies counts, then performs an irreversible directory cutover. Recovery resumes before cutover and never rolls back a published cutover.
- Per-DO admission includes measured `databaseSize`, estimated fact/index/projection/staging growth, WAL/checkpoint reserve, migration reserve, and at least 2 GB uncertainty headroom under an 8 GB accounted limit. It is a conservative policy estimate, not a measured physical cap; the bounded Cloudflare run did not calibrate physical size.
- Transaction, outcome-retention, read-lease, split, directory, query fan-out, scan, result, and per-entity bounds are explicit in RFD0004 and `poneglyph/src/storage/constants.ts`.
- Coordinator/shard schema creation is atomic and stores a schema-kind/version marker. Unversioned or incompatible SQLite namespaces fail closed before application DDL; automatic migration/import from the historical fixed-leaf schema is not implemented. Deployments must use a fresh namespace/graph unless a separate importer is provided.
- HTTP/WebSocket TODO routes require the signed session. The Worker sends invalidations only after the commit response; delivery is best-effort and has no durable outbox.

## Remaining limits

The 1 TB figure is synthetic accounting only. The per-graph coordinator serializes writes, a split pauses graph writes while copying, queries fan out to at most 256 leaves, transactions have at most 32 participants, and one hot entity/hash range can be unsplittable. The small Cloudflare benchmark does not predict production throughput, physical storage, CPU duration, or user-specific bills. The TODO notification channel can miss an invalidation after a successful commit; clients must re-query on reconnect. Historical/as-of queries, general-purpose query optimization, schema evolution/import, global replication, and source connectors remain out of scope.

## Local review gates

```sh
cd poneglyph
pnpm install --frozen-lockfile
pnpm check
pnpm test:capacity
pnpm bench:local
pnpm build
pnpm exec cf deploy --dry-run
pnpm exec cf deploy --mode cleanup --dry-run
```

The formal model checker requires a JDK and a pinned TLA+ tools JAR:

```sh
TLA2TOOLS_JAR=/path/to/tla2tools.jar ./specs/check.sh
```

Only after local gates pass should account-level checks use a unique temporary host beneath `*.poneglyph.leostera.dev`. Follow the preflight, secret-handling, deployment, cost limitations, and exact cleanup verification steps in the package README. Do not modify FokosDB, unrelated `.pi/` files, or unrelated Cloudflare resources.
