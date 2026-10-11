# RFD0004: Expandable, Capacity-Bounded Cloudflare Sharding

## Status

Draft implementation contract with bounded validation evidence (2026-10-11). The TypeScript branch implements prefix routing, durable split/cutover/recovery, conservative byte admission, the authenticated TODO demo, and local/deployed benchmark harnesses. One isolated expandable-topology smoke and bounded benchmark completed; detailed results and limitations are recorded in [`poneglyph/README.md`](../../poneglyph/README.md). This amendment supersedes the fixed-four-leaf *future architecture* choice in [RFD0003](./RFD0003-cloudflare-native-graph-database.md). The four-leaf layout remains an accurate description of the earlier checkpoint, not the current source.

## Summary

Replace fixed modulo sharding with a sparse, expandable prefix directory over a stable 256-bit entity hash. Every node is an instance of `GraphShardDO` with a durable `leaf` or `router` role; splitting changes the old leaf into a router and creates two child leaves. This avoids a fixed application-level leaf-count limit without introducing a second DO class or a flat directory table. A graph-wide durable topology lock pauses writes while a bounded snapshot is copied and verified; one directory-epoch update publishes the children. Previous owners remain read-only until leases pinned to the old directory epoch drain. The durable `txId` protocol is unchanged, and `visible_seq` advances only after every transaction participant applies. Every DO admits against an 8,000,000,000-byte accounted ceiling, with explicit write/index/projection, WAL, migration, and headroom estimates. A deterministic simulator accounts 1 TB across virtual entities without writing synthetic payloads; it is not a physical 1 TB capacity or throughput claim.

The models in [`specs/`](../../specs/README.md) make the visibility and split/cutover assumptions executable with PlusCal and TLC. Passing those small models is a design check, not proof of the implementation.

## Context

RFD0003's initial checkpoint uses one graph coordinator and four entity-hash leaves. `poneglyph/src/storage/keys.ts` fixes the shard count in both routing and object names. That topology was intentionally small enough to establish transaction visibility, versioned reads, and bounded distributed Datalog; changing a modulo count after writes would remap every entity without moving its state.

The next branch phase removes the Rust workspace and makes TypeScript the only Poneglyph implementation on this branch. It adds elastic placement without weakening the durable fact log, replayable projections, or all-or-nothing visibility. The Cloudflare SQLite storage API is private to each DO and provides a current database-size measurement (`ctx.storage.sql.databaseSize`) [CF1]. Cloudflare documents up to 10 GB of SQLite storage per DO [CF2], but the account plan, operational reserve, indexes, SQLite growth, and temporary migration work mean that limit is not a safe application target.

## Goals

- Replace fixed `SHARD_COUNT` routing with expandable logical virtual shards and a durable shard directory.
- Permit new leaf and router DOs to be added on demand without a hard-coded aggregate shard-count ceiling.
- Define split/move, stale-route, read-lease, and recovery behavior precisely enough to test.
- Keep `txId` atomic visibility through participant failure, split, retry, and recovery.
- Reject transactions before their predicted storage growth would consume safety headroom or cross the accounted 8 GB ceiling.
- Bound per-graph transaction participants, query fan-out, directory traversal, read leases, and coordinator state.
- Show a 1 TB *synthetic accounted-byte* topology while physically storing only a small dataset.
- Model the core commit and split algorithms in small PlusCal/TLA+ state spaces and model-check their invariants.

## Non-goals

- Literal infinite capacity, a promise that any Cloudflare account can provision unlimited objects, or a physical 1 TB load test.
- Parallel commit sequencing, a distributed consensus service, multi-region replication, or removal of the graph-level commit coordinator in this phase.
- Splitting one entity's facts across shards. All facts for one entity remain co-located; one pathological entity or hash collision can therefore remain an unsplittable hot key and must be rejected at its per-entity limit.
- Unbounded transaction participants, global scans without fan-out budgets, a general-purpose query optimizer, historical/as-of queries, schema evolution, or source connectors.
- Changes to FokosDB.

## Design

### Routing and directory

1. Compute a stable virtual key as `SHA-256(graphId || 0x00 || canonicalEntityUri)`. The 256-bit key is independent of the physical shard layout. A sparse binary prefix tree partitions this keyspace: an active leaf owns one prefix range; a router node owns two child-prefix pointers. A split consumes the next hash bit and replaces one leaf with two narrower ranges. This has no configured leaf-count limit in the application. The finite hash namespace, Cloudflare account quotas, and one-entity locality remain real limits; this is not literal infinity.
2. Route by following the prefix tree from the deterministic root `GraphShardDO` name. Each node records `{graphId, prefix, generation, role, splitEpoch, child prefixes, migration state}`. A leaf split turns that node into a two-pointer router and creates child leaves; later child splits recurse, so router metadata remains constant-sized and the directory is not a flat list. The separate `GraphCoordinatorDO` stores `visible_seq`, `directory_epoch`, the writer/topology reservations, bounded transaction outcomes, read leases, and one row per in-flight split; it stores no fact log and no all-leaf routing table. Router and leaf roles currently share one class and SQL schema.
3. A query resolves routes against its leased directory epoch; field-only scans recursively enumerate at most 256 leaves. Transaction planning resolves every fact key, groups by owner, and sends `{prefix, generation, directoryEpoch}`. The coordinator rechecks the epoch and topology lock in the same local transaction that reserves the writer. A participant accepts writes only when its persisted role/generation is the active leaf; stale/fenced requests fail before apply. There is no cross-request route cache in this implementation.
4. Routing IDs and the directory format are versioned. Existing fixed-v1 objects are never silently reinterpreted under new routing. A future explicit importer must enumerate v1 facts, verify them in v2 ownership ranges, and cut over an explicitly versioned root. This prototype does not implement that importer: schema initialization rejects an unversioned namespace, and the demo starts with a fresh v2 graph.
5. Directory and data leaves use separate roles and bounds. A prefix split can create child data leaves and router metadata. If the children would remain over the operating target, split the heavier child again. If the prefix has no useful entropy or one entity dominates the range, fail closed with a capacity error rather than claiming that a split succeeded.

The graph coordinator remains a serialized per-graph write/visibility authority in this phase. Hierarchical routing removes the fixed leaf-count and flat-directory-size limit, but does not remove the coordinator's write-throughput ceiling. That limitation is explicit and benchmarked, not hidden behind the phrase “infinite scale.”

### Transaction, snapshot, and notification contract

- Every accepted `txId` is bound to one canonical payload hash. The graph coordinator persists the payload/participant plan before preparing. A retry with the same id and payload resumes or returns the durable outcome; reuse with another payload is a conflict during the seven-day idempotency window. Append-only fact IDs also include the assigned commit sequence and batch index, so reuse after expiry cannot collide with prior log rows.
- Resolve the current owner for each entity and group facts by distinct leaf. A transaction is rejected before prepare if it exceeds **32 participant leaves**, the existing fact/byte limits, or any participant's projected capacity. The single graph coordinator admits at most one graph write decision at a time; contention returns a retryable busy response. This intentionally bounds prepare fan-out and preserves one total commit sequence.
- Participants prepare invisibly. After all acknowledge, the coordinator durably chooses commit; after that point recovery must apply the commit and may never cancel it. Participant apply and recovery are idempotent. Abort is possible only before the durable commit decision.
- A committed participant records its fact-log and versioned projection effects at one `commit_seq`. Only after every participant confirms apply does one local coordinator transaction set the completed outcome and advance `visible_seq`. This is the `txId` visibility point. Reads acquire a bounded lease containing both `{snapshotSeq: visible_seq, directoryEpoch}` and use that pair for every shard request. Each participant filters derived rows by that same sequence. A read result is not returned until all bounded shard streams complete; it is all effects or none.
- A split cannot cut across an undecided write. The topology operation reserves the graph's serialized writer slot, waits for any writer/recovery to finish, records its base visible sequence and directory epoch, and fences the source before copying. The initial implementation conservatively pauses **all graph writes** for the copy/cutover window (reads continue). This is stricter than a range-only write fence but avoids stale participant plans while the first router protocol is proven. It is an explicit availability/latency trade-off; a future range-only fence requires routing-epoch revalidation and another PlusCal model before adoption.
- TODO/WebSocket invalidations are emitted only after the coordinator publishes `visible_seq`, never on prepare or participant apply. The invalidation is a hint (`graphId`, committed sequence, affected list IDs), not a second source of truth. Clients re-query the new visible snapshot. The current demo uses best-effort post-response delivery, logs hub failures, and refreshes clients after WebSocket reconnect; it has no durable outbox and can miss an invalidation if delivery fails after commit. That reliability gap is an explicit prototype limitation, not permission to notify before visibility. A production service needs a durable outbox or replayable notification cursor tied to the commit record.

### Split/move state machine

The coordinator's `graph_splits` row stores `migrationId`, source prefix/generation, child prefixes, `baseVisibleSeq`, old/new directory epochs, a `force` flag, and lifecycle phase. The source identity stores the active migration and child metadata; destination page receipts contain table/child/page number, digest, and row count. The source owns truth until cutover.

| State | Routing and writes | Recovery rule |
| --- | --- | --- |
| `ACTIVE` | Source is the only owner and accepts normal transactions. | No migration work. |
| `FENCED_COPYING` | Directory still routes reads to source. The graph coordinator rejects all new writes with a retryable topology-busy response; the source also rejects writes. Children receive idempotent copy pages. | Resume from persisted cursor or restart an idempotent page; source remains authoritative. Partial child data is unreachable to normal routing. |
| `READY` | Copy and verification at `baseVisibleSeq` are complete; source remains the route. | Re-verify checksums and destination capacity, then retry cutover or abort before cutover. |
| `CUTOVER` | One SQLite transaction changes the parent directory node from leaf to router and increments its generation. New snapshots route to children; old-generation reads may still use the retained read-only parent. | Cutover is irreversible. Recovery uses the directory generation as authority and finishes retirement, never restores the parent as current owner. |
| `RETIRED` | Old-generation leases have expired; parent data is no longer needed for reads and may be reclaimed. | Children remain authoritative; a tombstone rejects stale parent writes and route requests. |

Copy the append-only `fact_log` plus the matching versioned `active_facts`, `active_values`, and `entity_versions` rows in bounded pages. The projections are copied as a consistent checkpoint and remain disposable/replayable from the authoritative facts. Each target verifies every page digest and stores an idempotency receipt in the same SQL transaction as its inserts; the coordinator verifies per-table row counts before cutover. Page cursors are deterministic SQLite row IDs. On restart the current implementation safely replays export from the first page (receipts make repeats idempotent) rather than persisting a coordinator cursor. Since all graph writes are fenced before copying, there is no dual-write/delta-log window and the copy represents one exact `visible_seq`. Before cutover, a failed operation remains locked and retry resumes from the beginning; the source remains authoritative. After cutover, never roll back to a possibly stale copy.

A read lease pins `(visible_seq, directoryEpoch)`. Before cutover, readers use the source. After cutover, new readers use children; readers holding the previous epoch may finish against the old read-only parent. Keep the parent until all old-epoch leases expire or finish. The existing bounded lease TTL is retained (30 seconds in the checkpoint); expired reads fail rather than mixing epochs. Parent retirement is not allowed while any such lease exists.

### Capacity accounting and admission

Cloudflare's documented 10 GB SQLite per-DO limit is the platform boundary, not the target. Poneglyph uses decimal bytes and sets an **8,000,000,000-byte accounted ceiling per DO**. The account/plan may impose additional limits. Because a reported SQL database size does not by itself establish a hard upper bound on every transient WAL, page, or import allocation, the 8 GB number is an application admission invariant, not a claim that platform physical usage is always exactly measured.

For each data or router DO, keep an auditable accounting row with these non-overlapping estimates:

- `sqliteDatabaseBytes`: `ctx.storage.sql.databaseSize`, which includes the DO's current SQLite database tables and indexes as reported by Cloudflare [CF1]. It therefore includes the append-only fact rows, materialized index/projection rows, and internal SQL metadata currently present in that database; table-level serialized estimates are retained separately for explainability, not added a second time.
- `pendingWriteBytes`: conservative upper-bound delta for the transaction payload, newly appended facts, index mutations, the next full entity projection (including the measured current projection size), participant records, and SQL/page overhead. Active-index amplification and projection growth are separate estimate categories; do not use request-body bytes as if they were database growth.
- `walAndCheckpointReserve`: bounded WAL/checkpoint growth estimate not already represented by `databaseSize`.
- `migrationReserve`: largest in-flight page/import and rebuild workspace reserved on the destination. A split starts only if both children can reserve this without crossing the limit.
- `uncertaintyHeadroom`: at least **2,000,000,000 bytes** reserved for estimator error, page fragmentation, and other temporary growth. It is not available to ordinary writes.

Admission is `databaseSize + pendingWriteBytes + walAndCheckpointReserve + migrationReserve + uncertaintyHeadroom <= 8,000,000,000` on every participant and router that must persist the operation. Indexes and projections count whether or not they are user-visible; a planned index/schema change must add its full projected bytes before activation. Reject the transaction before prepare if any participant fails this inequality. Start a split/move at or before a measured/estimated 5,000,000,000 bytes of persistent data so it has room to copy and recover. If `databaseSize` is unavailable in a local runtime, use the same conservative row estimator and label that result estimated; never turn a missing measurement into zero. Record the reported DB size and accounted estimate separately in telemetry. Keep the account's aggregate Durable Object storage chart and actual bill as independent verification [CF4].

This is an enforceable accounted-byte policy only to the extent that the pending/WAL/import estimators are conservative. Calibrate the estimator against real DO runs; if a safe bound cannot be demonstrated, lower the operating target or reject writes earlier. Do not claim a physical 8 GB cap from synthetic estimates alone. The separate 2 GB reserve is held inside the 8 GB account, leaving a further nominal margin to Cloudflare's documented 10 GB per-object maximum.

### Explicit service bounds

Initial implementation bounds (constants, covered by tests and emitted in responses/metrics):

| Resource | Bound |
| --- | ---: |
| Per-transaction participant leaves | 32 |
| Per-transaction facts / canonical bytes | Existing checkpoint bound: 1,000 facts / 1,000,000 bytes |
| Concurrent graph write decisions | 1; coordinator returns retryable busy |
| Retained completed/aborted coordinator and participant `txId` outcomes | 100,000 coordinator outcomes per graph; participant terminal rows prune after the same seven-day idempotency window |
| Live read leases per graph | 128, each pinned to one snapshot sequence and directory epoch |
| Transaction participant fan-out | 32 leaves maximum; automatic preflight may trigger at most 8 splits per write |
| Leaf fan-out per query | 256 distinct leaves and 511 directory nodes; excess fails with a budget error |
| Query duration and aggregate scan limits | Existing 20 s / tuple / byte / result budgets, retained and measured |
| Directory lookup | Prefix depth at most 256; owner lookup visits at most 257 nodes (root plus 256 edges) |
| Data/router/coordinator storage | Accounted bytes at most 8,000,000,000 per DO including reserved headroom |

The shard count itself has no configured application maximum, but a single query and transaction do. Whole-graph scans above the query leaf budget need a later paginated/distributed-aggregation contract; they do not bypass limits or fan out without bound. The one-writer coordinator and per-graph query bounds are throughput and availability limits even when aggregate stored bytes can grow.

## 1 TB synthetic capacity envelope

Use decimal bytes (`1 TB = 1,000,000,000,000 bytes`). The current deterministic simulator generates 10,000 small virtual entity keys, assigns synthetic byte weights totaling 1 TB, and applies the same 256-bit prefix partitioning and 5,000,000,000-byte split trigger; it performs zero physical row writes. The separate small real-data integration tests write and split only a few facts. The simulator accounts persistent logical bytes plus the 10% WAL/checkpoint reserve and 2 GB headroom and checks each leaf against 8,000,000,000 bytes. It does not claim a physical database measurement or model a per-account service quota.

The recorded default run assigns 1 TB across 10,000 synthetic keys and produces 271 leaf ranges, 270 router nodes, maximum prefix depth 9, a largest leaf of 4.9 GB, and a maximum accounted leaf of 7.39 GB; synthetic `physicalRowsWritten` is zero. Router metadata and the live graph coordinator are small separate DOs; their real SQL size is independently checked by admission at transaction/topology reservation. Distribution changes can increase the leaf count; this is not a promise that Cloudflare will allocate 1 TB to one account. It proves only this deterministic arithmetic/topology model, not physical estimator accuracy or 1 TB performance.

## Formal model and validation

[`specs/TransactionVisibility.tla`](../../specs/TransactionVisibility.tla) and [`specs/ShardSplit.tla`](../../specs/ShardSplit.tla) are PlusCal algorithms translated and checked by TLC with two abstract participants and one parent/two children. The first checks `visible_seq` cannot publish before every participant applies, recovery can retry an irrevocable commit, and a pinned read result is all-or-nothing. The second checks fenced copying, recovery of missing pages, complete copy before cutover, generation change, old-reader retention, route/data agreement, and post-cutover writes. Run with `TLA2TOOLS_JAR=/path/to/tla2tools.jar ./specs/check.sh`.

The models intentionally abstract away actual SQLite state, Cloudflare request delivery, multiple overlapping writers, abort/cancel behavior, bounds arithmetic, real hash distributions, and worker/network failures beyond interruption between durable steps. Passing TLC does not substitute for TypeScript fault-injection tests. The model and implementation contracts must be updated together if implementation reveals a counterexample or changes the protocol.

## Cloudflare quotas and costs

Cloudflare currently documents a 10 GB SQLite database maximum per DO and no hard maximum number of DOs per namespace, while noting account/plan limits and usage-based charges [CF2–CF4]. Those provider statements are not a guarantee of unlimited aggregate storage or a user-specific quota. At the current published Workers pricing page, SQLite DO storage has 5 GB-month included on the paid plan and is $0.20/GB-month above that; row reads/writes and DO compute/request-duration are billed separately. The published paid-plan table currently includes 25 billion reads/month and 50 million writes/month before its listed overage rates ($0.001/million reads and $1/million writes). At a simplified decimal 1,000 GB-month, storage alone would be roughly **$199/month** after 5 GB-month included, before index amplification, temporary split copies, rows written/read, requests, CPU duration, and account-specific terms. This is arithmetic from the published rate card, not a cost estimate for the benchmark. Free-plan and account-specific limits differ; the effective plan and billing dashboard must be checked before the bounded deployment.

For the bounded 2026-10-11 validation, the account subscription list showed an existing `Workers Paid` plan at $5/month before and after the run (21 subscription records both times); no new subscription was added. Billing-history and metered-usage API reads returned HTTP 403 under the available CLI authentication. Therefore no incremental usage charge can be confirmed and the result must not be reported as $0. The small test recorded request latency, query scan/fan-out/tuple/byte counters, and transaction/query outcomes, but did not capture individual DO `databaseSize`, aggregate namespace storage, CPU duration, or SQL row read/write billing metrics. This run does not calibrate the 8 GB estimator or establish physical storage usage.

Before any larger or longer deployment, obtain a billing/usage view and DO storage telemetry. The user-authorized smoke was capped at 10 single-shard transactions, 10 cross-shard TODO moves, and 10 query requests per topology; its actual usage was not independently visible through the available billing API, so no zero-charge or included-quota conclusion is asserted. This small bounded run does not justify an unbounded test when detailed billing visibility is unavailable. See the exact sample and cleanup record in [`poneglyph/README.md`](../../poneglyph/README.md).

## Bounded isolated Cloudflare validation (2026-10-11)

The expandable version was deployed only as `poneglyph-scaleout-validation-20261011` at `poneglyph-scaleout-20261011.poneglyph.leostera.dev`, with `workersDev` disabled and three temporary SQLite DO classes. The authenticated TODO smoke rejected unauthenticated HTTP/WebSocket access, performed a two-participant task move, received matching invalidations on two authenticated clients, and re-queried the destination list at the published commit sequence. The generic smoke verified a four-fact commit, same-`txId` replay, and a four-row query. A 10-transaction / concurrency-2 sample measured 3.41 tx/s single-shard and 2.44 cross-shard TODO moves/s; query latencies and counters are tabulated in the package README. Five query samples per shape make p95/p99 equal the observed maximum, so they are not meaningful tail estimates. These public-network results are exploratory and are neither an SLA nor physical capacity evidence.

Cleanup deployed the class-deletion mode, deleted the dedicated Worker, and verified no matching script, DO namespaces, Worker-managed DNS record, secret, or certificate pack remained. The generated certificate pack disappeared asynchronously after a `pending_deletion` state; no unrelated account resources were changed. A startup-only atomic schema-kind/version marker and fail-closed guard was added after this account run; it passed local workerd tests/build but was not redeployed. The transaction, migration, and query paths measured here were unchanged. The prior fixed-leaf Cloudflare run remains a separate historical record and is not included in these results.

## Alternatives

| Option | Trade-off |
| --- | --- |
| Keep four fixed hash leaves | Lowest complexity, but after enough data one leaf crosses its budget and there is no safe incremental capacity path. Retained only as the historical checkpoint and regression baseline. |
| Recompute `hash(entity) % N` when adding leaves | A count change remaps existing entities; without a data migration, writes route to empty owners and queries miss old facts. Rejected. |
| Fixed large virtual-bucket array | Allows reassigning buckets but hard-codes a maximum routing table and makes directory size grow linearly in every router. A sparse prefix tree is simpler to grow and recursively split. |
| Copy-on-write with dual writes during a long copy | Reduces write fencing but makes cross-shard commit participation, duplicate replay, and cutover much more complex. The first implementation pauses all graph writes during copy; it favors a checkable snapshot over availability. Revisit only with a measured pause problem and a separately model-checked delta protocol. |
| One central directory map | Simple but itself reaches the per-DO ceiling. Use recursively splittable router nodes; keep the coordinator's small global visibility state separate. |
| Remove the coordinator or allow independently sequenced shards | Higher write throughput, but no single `visible_seq` linearization point for graph-wide `txId` reads. Not selected because it weakens the present contract. |

## Consequences and open questions

- A split temporarily stores a second copy of the moved prefix. Capacity admission must reserve import and index-rebuild space on both children before copying. If safe reservation fails, the split does not start.
- All graph writes receive a retryable response during a split; read-only work continues through the pinned directory epoch. Copying a large source may therefore cause a long write pause. Very large single prefixes, hot entities, or poor hash distribution may not split evenly; capacity failures are explicit.
- The graph coordinator serializes writes and is a per-graph throughput bottleneck. The design scales data placement, not arbitrarily concurrent commit throughput.
- Query fan-out is bounded to 256 leaves in the first implementation; a 1 TB graph may need selective queries, pagination, or a separately designed aggregate path.
- `databaseSize` is a useful direct signal, not a complete guarantee of temporary WAL and migration headroom. The account-visible namespace metric and bounded deployment must calibrate the estimator.
- The implementation retains coordinator and participant terminal transaction outcomes for seven days and allows at most 100,000 completed/aborted coordinator outcomes per graph. Participant terminal rows are pruned on prepare after expiry; topology copy includes only facts and their derived indexes/projections because no in-flight transaction can coexist with the write fence. This is an explicit idempotency window, not indefinite replay protection. Deployment telemetry must verify the `databaseSize`/WAL/import estimates against Cloudflare's aggregate storage metric.

## References

- [CF1] [SQLite-backed Durable Object Storage API (`databaseSize`)](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [CF2] [SQLite in Durable Objects GA with 10 GB storage per object](https://developers.cloudflare.com/changelog/post/2025-04-07-sqlite-in-durable-objects-ga/)
- [CF3] [Durable Objects concepts and per-namespace object count](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
- [CF4] [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [namespace storage metrics](https://developers.cloudflare.com/changelog/post/2026-07-20-durable-objects-total-storage-metrics/)
