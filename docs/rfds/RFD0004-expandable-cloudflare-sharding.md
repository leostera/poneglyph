# RFD0004: Expandable, Capacity-Bounded Cloudflare Sharding

## Status

Draft. This amendment defines the scale-out direction for the TypeScript branch; it does not claim the design is implemented. It supersedes the fixed-four-leaf *future architecture* choice in [RFD0003](./RFD0003-cloudflare-native-graph-database.md). The four-leaf layout remains an accurate description of the completed checkpoint, and is not an acceptable scale-out endpoint.

## Summary

Replace fixed modulo sharding with a sparse, expandable prefix directory over a stable 256-bit entity hash. Directory router nodes and data-leaf Durable Objects split independently, with no configured application-level maximum number of shards. A leaf is fenced while a durable snapshot is copied and verified; one atomic directory-pointer/epoch update publishes its children. Previous owners remain read-only until leases pinned to the previous directory epoch expire. Writes continue to use the durable `txId` prepare/commit/apply protocol, and the graph's `visible_seq` advances only after all participants apply. Each DO admits work against an 8,000,000,000-byte *accounted* ceiling, with explicit estimates for facts, indexes, projections, WAL/staging, migration copies, and reserved headroom. A synthetic allocator will demonstrate a 1 TB accounted envelope using small real data; it is not a physical 1 TB capacity or throughput claim.

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
2. Route by longest matching prefix from the graph's directory root. Each directory node is a small SQLite-backed `GraphRouterDO` addressed by a stable graph/prefix name and records `{prefix, generation, state, child IDs or leaf ID}`. Router nodes also have byte budgets and split recursively, so one growing root map is not the design's permanent directory-capacity ceiling. A small coordinator root stores the current root ID, global `visible_seq`, the writer reservation, transaction outcomes, and read leases. It does not store every fact or a flat list of all leaves.
3. A cached route is a hint tagged with its directory generation. Leaf RPCs carry the expected generation and hash range. A fenced leaf or stale generation fails with a typed retryable stale-route response; the caller resolves again through the directory. No leaf accepts a write solely because a caller supplied its old object name.
4. Routing IDs and the directory format are versioned. Existing fixed-v1 objects are never silently reinterpreted under new routing. The migration/import path must enumerate v1 facts, verify them in v2 ownership ranges, and cut over an explicitly versioned root; the new demo starts with a fresh v2 graph.
5. Directory and data leaves use separate roles and bounds. A prefix split can create child data leaves and router metadata. If the children would remain over the operating target, split the heavier child again. If the prefix has no useful entropy or one entity dominates the range, fail closed with a capacity error rather than claiming that a split succeeded.

The graph coordinator remains a serialized per-graph write/visibility authority in this phase. Hierarchical routing removes the fixed leaf-count and flat-directory-size limit, but does not remove the coordinator's write-throughput ceiling. That limitation is explicit and benchmarked, not hidden behind the phrase “infinite scale.”

### Transaction, snapshot, and notification contract

- Every accepted `txId` is bound to one canonical payload hash. The graph coordinator persists the payload/participant plan before preparing. A retry with the same id and payload resumes or returns the durable outcome; reuse with another payload is a conflict.
- Resolve the current owner for each entity and group facts by distinct leaf. A transaction is rejected before prepare if it exceeds **32 participant leaves**, the existing fact/byte limits, or any participant's projected capacity. The single graph coordinator admits at most one graph write decision at a time; contention returns a retryable busy response. This intentionally bounds prepare fan-out and preserves one total commit sequence.
- Participants prepare invisibly. After all acknowledge, the coordinator durably chooses commit; after that point recovery must apply the commit and may never cancel it. Participant apply and recovery are idempotent. Abort is possible only before the durable commit decision.
- A committed participant records its fact-log and versioned projection effects at one `commit_seq`. Only after every participant confirms apply does one local coordinator transaction set the completed outcome and advance `visible_seq`. This is the `txId` visibility point. Reads acquire a bounded lease containing both `{snapshotSeq: visible_seq, directoryEpoch}` and use that pair for every shard request. Each participant filters derived rows by that same sequence. A read result is not returned until all bounded shard streams complete; it is all effects or none.
- A split cannot cut across an undecided write. The topology operation reserves the coordinator's topology slot, waits for any writer/recovery to finish, records its base visible sequence, and fences writes to the selected source prefix before copying. Unaffected-prefix writes may continue and advance the graph sequence; the fenced prefix has no new commits during its import.
- TODO/WebSocket invalidations are emitted only after the coordinator publishes `visible_seq`, never on prepare or participant apply. The invalidation is a hint (`graphId`, committed sequence, affected list IDs), not a second source of truth. Clients re-query the new visible snapshot. A durable outbox or replayable notification cursor must tie delivery to the commit record so coordinator restart cannot publish an uncommitted event.

### Split/move state machine

A split record stores `migrationId`, source prefix and generation, child IDs, `baseVisibleSeq`, copy cursor/checksum, and lifecycle state. The source owns truth until cutover.

| State | Routing and writes | Recovery rule |
| --- | --- | --- |
| `ACTIVE` | Source is the only owner and accepts normal transactions. | No migration work. |
| `FENCED_COPYING` | Directory still routes reads to source. Source rejects writes for its prefix with retryable `shard_moving`; unaffected prefixes may write. Children receive idempotent copy pages. | Resume from persisted cursor or restart an idempotent page; source remains authoritative. Partial child data is unreachable to normal routing. |
| `READY` | Copy and verification at `baseVisibleSeq` are complete; source remains the route. | Re-verify checksums and destination capacity, then retry cutover or abort before cutover. |
| `CUTOVER` | One SQLite transaction changes the parent directory node from leaf to router and increments its generation. New snapshots route to children; old-generation reads may still use the retained read-only parent. | Cutover is irreversible. Recovery uses the directory generation as authority and finishes retirement, never restores the parent as current owner. |
| `RETIRED` | Old-generation leases have expired; parent data is no longer needed for reads and may be reclaimed. | Children remain authoritative; a tombstone rejects stale parent writes and route requests. |

Copy the append-only source facts in bounded, resumable pages. Copy committed transaction/sequence metadata needed by projections, then rebuild or verify active indexes and entity projections from those facts; projections remain disposable derived state. Since writes touching the source are fenced before taking the copy snapshot, there is no unbounded dual-write/delta-log window. If a page, child, or verification step fails before cutover, retry or discard the children and un-fence the still-authoritative source. After cutover, never roll back to a possibly stale copy.

A read lease pins `(visible_seq, directoryEpoch)`. Before cutover, readers use the source. After cutover, new readers use children; readers holding the previous epoch may finish against the old read-only parent. Keep the parent until all old-epoch leases expire or finish. The existing bounded lease TTL is retained (30 seconds in the checkpoint); expired reads fail rather than mixing epochs. Parent retirement is not allowed while any such lease exists.

### Capacity accounting and admission

Cloudflare's documented 10 GB SQLite per-DO limit is the platform boundary, not the target. Poneglyph uses decimal bytes and sets an **8,000,000,000-byte accounted ceiling per DO**. The account/plan may impose additional limits. Because a reported SQL database size does not by itself establish a hard upper bound on every transient WAL, page, or import allocation, the 8 GB number is an application admission invariant, not a claim that platform physical usage is always exactly measured.

For each data or router DO, keep an auditable accounting row with these non-overlapping estimates:

- `sqliteDatabaseBytes`: `ctx.storage.sql.databaseSize`, which includes the DO's current SQLite database tables and indexes as reported by Cloudflare [CF1]. It therefore includes the append-only fact rows, materialized index/projection rows, and internal SQL metadata currently present in that database; table-level serialized estimates are retained separately for explainability, not added a second time.
- `pendingWriteBytes`: conservative upper-bound delta for the transaction payload, newly appended facts, index mutations, projection versions, participant records, and SQL/page overhead. Calculate by classifying the exact planned effects before prepare; do not use request-body bytes as if they were database growth.
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
| Live read leases per graph | 128 |
| Leaf fan-out per query | 256 distinct leaves; exceeding this fails with a budget error |
| Query duration and aggregate scan limits | Existing 20 s / tuple / byte / result budgets, retained and measured |
| Directory lookup | Prefix depth at most 256; cached route is generation-checked |
| Data/router storage | Accounted bytes at most 8,000,000,000 per DO including reserved headroom |

The shard count itself has no configured application maximum, but a single query and transaction do. Whole-graph scans above the query leaf budget need a later paginated/distributed-aggregation contract; they do not bypass limits or fan out without bound. The one-writer coordinator and per-graph query bounds are throughput and availability limits even when aggregate stored bytes can grow.

## 1 TB synthetic capacity envelope

Use decimal bytes (`1 TB = 1,000,000,000,000 bytes`). The synthetic simulator starts with the small One Piece fixture and a small physical DO database, then assigns deterministic synthetic growth to virtual entity keys without inserting that growth into SQLite. It includes facts, active indexes, projection versions, participant/WAL reserves, per-leaf uncertainty headroom, and directory metadata in its accounting. It repeatedly splits a leaf when its projected occupancy reaches the 5,000,000,000-byte operating target, then checks every resulting DO against the 8,000,000,000-byte admission inequality.

A simple balanced lower-bound illustration is **200 data leaves × 5,000,000,000 accounted bytes = 1 TB accounted**. This leaves the 2 GB per-leaf reserve inside each 8 GB budget; router/coordinator DOs are counted separately and must independently remain below the same cap. Skewed virtual-key distributions can require more than 200 leaves; the simulator must exercise skew and repeated nested splits, not just divide one integer evenly. The expected output is aggregate accounted bytes, active data/router DO counts, per-DO maxima and headroom, split count, distribution/skew settings, and a proof that no simulated object exceeds its admission ceiling. This demonstrates only the arithmetic and routing design. It does not prove Cloudflare will provide 1 TB for an account, prove the estimator's physical accuracy, or measure 1 TB performance.

## Formal model and validation

[`specs/TransactionVisibility.tla`](../../specs/TransactionVisibility.tla) and [`specs/ShardSplit.tla`](../../specs/ShardSplit.tla) are PlusCal algorithms translated and checked by TLC with two abstract participants and one parent/two children. The first checks `visible_seq` cannot publish before every participant applies, recovery can retry an irrevocable commit, and a pinned read result is all-or-nothing. The second checks fenced copying, recovery of missing pages, complete copy before cutover, generation change, old-reader retention, route/data agreement, and post-cutover writes. Run with `TLA2TOOLS_JAR=/path/to/tla2tools.jar ./specs/check.sh`.

The models intentionally abstract away actual SQLite state, Cloudflare request delivery, multiple overlapping writers, abort/cancel behavior, bounds arithmetic, real hash distributions, and worker/network failures beyond interruption between durable steps. Passing TLC does not substitute for TypeScript fault-injection tests. The model and implementation contracts must be updated together if implementation reveals a counterexample or changes the protocol.

## Cloudflare quotas and costs

Cloudflare currently documents a 10 GB SQLite database maximum per DO and no hard maximum number of DOs per namespace, while noting account/plan limits and usage-based charges [CF2–CF4]. Those provider statements are not a guarantee of unlimited aggregate storage or a user-specific quota. At the current published Workers pricing page, SQLite DO storage has 5 GB-month included on the paid plan and is $0.20/GB-month above that; row reads/writes and DO compute/request-duration are billed separately. The published paid-plan table currently includes 25 billion reads/month and 50 million writes/month before its listed overage rates ($0.001/million reads and $1/million writes). At a simplified decimal 1,000 GB-month, storage alone would be roughly **$199/month** after 5 GB-month included, before index amplification, temporary split copies, rows written/read, requests, CPU duration, and account-specific terms. This is arithmetic from the published rate card, not a cost estimate for the benchmark. Free-plan and account-specific limits differ; the effective plan and billing dashboard must be checked before the bounded deployment.

Record actual namespace storage, DO requests/duration, SQL rows read/written, and any account-visible charge for the bounded run. Cloudflare's namespace storage chart is aggregate and does not expose every DO's individual stored bytes [CF4]; use per-object `databaseSize` telemetry plus the conservative application accounting. If storage or financial safety cannot be established before deployment, do not deploy.

## Alternatives

| Option | Trade-off |
| --- | --- |
| Keep four fixed hash leaves | Lowest complexity, but after enough data one leaf crosses its budget and there is no safe incremental capacity path. Retain only as the completed checkpoint and correctness baseline. |
| Recompute `hash(entity) % N` when adding leaves | A count change remaps existing entities; without a data migration, writes route to empty owners and queries miss old facts. Rejected. |
| Fixed large virtual-bucket array | Allows reassigning buckets but hard-codes a maximum routing table and makes directory size grow linearly in every router. A sparse prefix tree is simpler to grow and recursively split. |
| Copy-on-write with dual writes during a long copy | Reduces write fencing but makes cross-shard commit participation, duplicate replay, and cutover much more complex. The first scale-out implementation fences only the moving prefix and retries those writes. Revisit only with a demonstrated pause problem and a separately model-checked delta protocol. |
| One central directory map | Simple but itself reaches the per-DO ceiling. Use recursively splittable router nodes; keep the coordinator's small global visibility state separate. |
| Remove the coordinator or allow independently sequenced shards | Higher write throughput, but no single `visible_seq` linearization point for graph-wide `txId` reads. Not selected because it weakens the present contract. |

## Consequences and open questions

- A split temporarily stores a second copy of the moved prefix. Capacity admission must reserve import and index-rebuild space on both children before copying. If safe reservation fails, the split does not start.
- Writes touching a fenced prefix receive a retryable response during copy. Very large single prefixes, hot entities, or poor hash distribution may not split evenly; capacity failures are explicit.
- The graph coordinator serializes writes and is a per-graph throughput bottleneck. The design scales data placement, not arbitrarily concurrent commit throughput.
- Query fan-out is bounded to 256 leaves in the first implementation; a 1 TB graph may need selective queries, pagination, or a separately designed aggregate path.
- `databaseSize` is a useful direct signal, not a complete guarantee of temporary WAL and migration headroom. The account-visible namespace metric and bounded deployment must calibrate the estimator.
- Open questions for implementation: what WAL/import upper bound is measurable in workerd and production DOs; what retry/backoff makes a fenced-write pause acceptable; and what exact idempotency-retention policy keeps coordinator metadata under its own capacity budget?

## References

- [CF1] [SQLite-backed Durable Object Storage API (`databaseSize`)](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [CF2] [SQLite in Durable Objects GA with 10 GB storage per object](https://developers.cloudflare.com/changelog/post/2025-04-07-sqlite-in-durable-objects-ga/)
- [CF3] [Durable Objects concepts and per-namespace object count](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
- [CF4] [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [namespace storage metrics](https://developers.cloudflare.com/changelog/post/2026-07-20-durable-objects-total-storage-metrics/)
