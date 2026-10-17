# RFD0004: Expandable, Capacity-Bounded Cloudflare Sharding

## Status

Draft implementation contract with bounded validation evidence (2026-10-11). The TypeScript branch implements prefix routing, durable split/cutover/recovery, conservative byte admission, the authenticated TODO demo, and local/deployed benchmark harnesses. One isolated expandable-topology smoke and bounded benchmark completed; operating procedures, detailed results, and limitations are recorded below. [RFD0005](./RFD0005-write-path-experiment.md) records the later corrected write-path baseline. This amendment supersedes the fixed-four-leaf *future architecture* choice in [RFD0003](./RFD0003-cloudflare-native-graph-database.md). The four-leaf layout remains an accurate description of the earlier checkpoint, not the current source.

## Current implementation amendment

The single graph-wide sequencer/lock described below is the historical A contract. The user-selected sole implementation uses sixteen owner roots, pooled graph-bound journals, entity fences and leased vector reads, while retaining expandable prefixes and the existing capacity/query limits. See [RFD0005's current direction](./RFD0005-write-path-experiment.md#current-direction-one-implementation-2026-10-14). Earlier schema/routing checkpoints reject incompatible persistence; they do not silently migrate historical namespaces or make the simulator a physical-capacity proof.

## Four-role Durable Object decomposition (routing version 9 source)

The current source splits canonical storage across four SQLite Durable Object classes with one explicit request path: `GraphCoordinatorDO` → `GraphLedgerDO` → `GraphTreeDO` → `GraphShardDO`. This is implemented in `packages/poneglyph/src/storage/` and wired through `packages/poneglyph-worker/cloudflare.config.ts`. The four-role source was deployed to the private service and playground; deployment versions, the synthetic smoke fixture, and evidence limits are recorded in [RFD0006](./RFD0006-public-read-only-mcp-playground.md). Class/namespace names remain unversioned; deterministic instance names retain `v9`. No old state was copied.

- `GraphCoordinatorDO` is the graph-facing facade and owns the durable, fixed sixteen-root safe-read vector plus its monotonic frontier. `dispatchGraphRequest` always addresses `GRAPH_FACADES` first; the facade validates graph routes, dispatches writes to a ledger, captures read vectors, and owns bounded Datalog/query/schema/entity response behavior. It has no transaction alarm. The vector is a replayable coordination cache, not canonical fact state.
- `GraphLedgerDO` owns one graph/bucket's durable `candidate_transactions`, optional client-request-token mapping, recovery, retention and the single combined Durable Object alarm. Token rows and transaction rows share `LEDGER_OUTCOME_LIMIT`; they cannot independently consume the full per-bucket allocation. A token mapping whose candidate journal does not yet exist reserves both row slots, and journal creation fulfills that reservation rather than competing with unrelated writes. A token request is routed by `SHA-256(graphId || 0x00 || token)`. Its server-minted transaction ID encodes that bucket (`poneglyph:tx:token:<hex-bucket>:<uuid>`), so `transactionCoordinatorName` sends transaction retries, status checks and recovery back to the same ledger. Token and ledger state are committed in the same actor database before participant I/O.
- `GraphTreeDO` owns one of sixteen independent four-bit roots: directory epoch/visible publication revision, reservation tickets and entity locks, publication gates, read leases, retained-history floor, split state, and topology transitions. Reservation tickets are not query-visible revisions. Its schema no longer contains the ledger journal or facts.
- `GraphShardDO` owns prefix routers and leaves; only leaf shards store the append-only fact log and replayable fact/value/entity projections and indexes. A split moves those rows to children and leaves routing metadata in the parent.

A public write now follows `HttpGraphClient.transact` → `dispatchGraphRequest` → `GraphCoordinatorDO.fetch` → `dispatchPublicTransaction` → one `GraphLedgerDO` → affected `GraphTreeDO` roots and `GraphShardDO` participants. The ledger is selected by graph plus transaction ID; for tokenized writes the encoded bucket makes that route identical to the token's bucket. After all shard participants apply, each owner publishes its reserved local revision; the ledger then atomically merges the complete owner patch into the facade's cached safe vector, releases the owner gates, and only then acknowledges. Reads capture that vector in one facade-local SQLite transaction, pin the selected exact owner components through tree leases, and query shard leaves. Split cutover keeps the tree's topology operation active until its new directory epoch is durably reflected in the facade vector, preventing a writer from publishing against a stale cached epoch. Trees and shards also make bounded control/proof calls to one another during reservation, apply, publication and split recovery. No facts are copied between the old coordinator namespace and new role namespaces; incompatible old actor databases are not imported by this refactor.

`packages/poneglyph/src/storage/sql.ts` initializes separate fail-closed `g-facade`, `g-ledger`, `g-tree`, and `g-shard` schemas. The facade stores the fixed owner vector/frontier; trees store gates and a retained-history floor. Current schema marker versions are facade 2, ledger 1, tree 4, and shard 8; routing names use version 9. The tree/facade schema changes are fail-closed and have no in-place migration. This is a protocol implementation step, not a proof of Serializable/Linearizable/Strict-Serializable behavior or hosted throughput/capacity. Focused integrated-storage and type checks are the evidence reported in this amendment; it has not been deployed and no corpus import is part of it.

## Query execution amendment (2026-10-14)

The facade captures the persisted safe vector and global frontier in one local SQLite transaction, then acquires the selected owner read leases concurrently at those exact sequence/epoch components. Trees allow a lease while reservations, publication gates, and writes are active: the pinned sequence is an MVCC snapshot, and every scan filters by its `valid_from_seq`/`valid_to_seq`. A lease fences topology cutover and advances the per-tree history-retention floor, but it does not block new writes or publication. The tree rejects a component whose history floor has passed it. Evaluation begins only after all requested pins settle and every lease remains unexpired; it never substitutes a partial vector or a newer per-owner value. Vector capture and lease fan-out are not one cross-DO atomic action, so a tree may reject a captured component if topology/history has already advanced before its lease is registered; the query then fails closed rather than reading a different cut. On failure, wait for late acquisitions and release every known successful lease; unknown delivery is not retried and the existing lease expiry remains its fence. Release also waits for all requests to settle. Capturing the fixed vector is one facade-local operation; registering up to sixteen tree leases remains fixed-size parallel fan-out, so this is an O(1) capture goal, not zero owner RPCs or a formal complexity proof.

A narrow read optimization applies when a query contains exactly one positive fact relation whose entity term is a valid URI constant: only the independent tree root for that entity is leased. The single relation cannot read another entity, and its lookup, directory epoch, and shard snapshot all come from that same leased tree. Queries with unbound entities, value-to-entity joins, or multiple positive relations retain the full sixteen-root vector because their candidates may span roots. `readEntity` likewise leases only the entity's root. The returned snapshot vector states exactly which roots were pinned; `snapshotSeq` remains the maximum sequence in that vector and is not a graph-global clock. A failure to parse/route the literal falls back to the full cut rather than narrowing authority. This reduces read-lease fan-out without changing visibility, publication, source-of-truth, retention, or persistence/schema contracts.

A value-bound scan seeks the existing `active_values_by_field_value_snapshot` / `active_values_by_field_entity_value_snapshot` indexes through canonical `value_key`s. Because converting a `FactValue` to a Datalog value is many-to-one, the query path enumerates the canonical FactValue JSON keys whose typed conversion equals the requested Datalog value, then retains exact `datalog_type`/`datalog_value` predicates as a correctness guard. It does not assume every exposed string came from a text fact, and it adds no schema migration or persistent index.

A narrow physical query operator pushes `fieldA(Entity, Constant), fieldB(Entity, Value)` into an owner-local SQL bag join when the entity variables are identical and the output variable is distinct. Both sides use the captured subtree sequence. This includes category/title reads but contains no wiki-specific rules. General conjunctions and repeated-variable shapes retain ordinary unification. The join preserves source/list multiplicity and typed exposed Datalog equality, applies constraints after binding, and excludes entities without matching output facts. Its SQL cursor includes the entity and both assertion/value-index identities, so equal values survive page boundaries. It uses the same counted `scan-complete` plus verified EOF protocol, fanout, tuple-stream, byte, response, result and duration budgets; limits remain errors rather than partial success. `tuplesRead` counts emitted scan/join tuples, not physical SQLite rows visited. No new persistent projection or index is introduced.

For a three-clause cross-entity join whose first atom has a bound value, whose final atom binds a fresh entity from a value variable established by the prefix, the evaluator runs at most **four** independent final-atom scans concurrently. It still uses the same read vector and ordinary per-value scans; every scan/request/tuple remains charged to the existing budgets. Results are joined back with typed unification and preserve bag multiplicity; row ordering remains unspecified. The evaluator awaits every scan in a wave before emitting that wave, so one failed scan fails the query without leaving background work or a partial success. Other shapes retain source-order nested-loop evaluation. No index, persistent state, retry, or result cache is added. The focused evaluator regression gates duplicate-row preservation and the concurrency bound; hosted benefit remains unproven until an authorized deployment and like-for-like client round-trip measurement.

Within one query, an entity observed in a validated leaf stream may reuse that leaf's already resolved prefix/generation. This cache lives only under the same captured owner vector/directory epochs; it is neither cross-request routing nor a result/freshness cache.

Successful results additionally carry optional `metrics.distinctShardsTouched`, the number of distinct leaf `(prefix, generation)` identities actually contacted during the query; optional `metrics.treeReadLeaseAcquisitions`, the count of tree-root leases in its selected vector; and optional `metrics.timing = { executionMs, snapshotMs, evaluationMs, releaseMs }`. Older response parsers accept the new metric and newer clients continue to accept older responses without it. These nonnegative integer milliseconds measure coordinator elapsed time from validated query through completed evaluation and settled cleanup, before final result serialization. They exclude client/network latency and are not CPU measurements. Clients preserve timing when present, reject malformed/inconsistent groups, and accept older responses without timing. Custom `poneglyph.query`, `.snapshot`, `.evaluate` and `.release` spans expose the corresponding phases without logging query text or bindings. Workers clocks advance at I/O boundaries; zero-duration phases do not mean zero work. See [custom spans](https://developers.cloudflare.com/workers/observability/traces/custom-spans/) and [clock limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/).

Local gates passed: root check/build, focused ten-case warm/cold oracle regression, and the expanded 69-case checkpoint (138 warm/cold phases, zero failures; broader small-tier certification remains incomplete). New regressions cover late lease cleanup, failed-owner compensation, typed int64/text joins, 400 equal-value bag rows across SQL pages, source replacement/retraction, missing fields, constraint filtering, split routing, result-budget failure, and actual scan transport truncation/error faults on joined streams. Evidence: `packages/conformance/results/focused-controls-2026-10-14T16-33-33.952Z/` and `packages/conformance/results/2026-10-14T16-47-32.452Z/`. Their reports retain the dirty source snapshot/base revision and exact build digests; they are not universal correctness certification. After version and binding checks, the optimized Worker was deployed at 100% as `11da404e-d3ad-48ac-ab86-96c34c67de17`; its live bundle matched the build at `156a85e`, and graph namespaces/Access policy were unchanged. Six serial category-to-title queries before and six after returned the same exact independently corpus-derived multisets at snapshot404 (7 Marine and 41 Pirate Captain rows). Client round-trip median fell from 2,841 ms to 501 ms (82%, 5.7x); post-change coordinator elapsed median was 317.5 ms. Query counters fell from 8/42 scans and 23/57 shard requests to one scan/16 requests, respectively. A sampled slow post-change trace recorded a 756 ms subtree lease call, with 806 ms snapshot and 116 ms evaluation spans; the trace was incomplete. The uncached query remains above 100 ms, the six samples do not establish p95/p99, and this is not broad correctness, throughput, capacity, billing, or full-corpus certification. Sanitized comparison and trace details are in private research `personal/poneglyph/query-latency-trace/`; no query rows, credentials, headers or request URLs are retained.

## Summary

Replace fixed modulo sharding with a sparse, expandable prefix directory over a stable 256-bit entity hash. Every node is an instance of `GraphShardDO` with a durable `leaf` or `router` role; splitting changes the old leaf into a router and creates two child leaves. This avoids a fixed application-level leaf-count limit without introducing a second DO class or a flat directory table. A graph-wide durable topology lock pauses writes while a bounded snapshot is copied and verified; one directory-epoch update publishes the children. Previous owners remain read-only until leases pinned to the old directory epoch drain. The durable `txId` protocol is unchanged, and `visible_seq` advances only after every transaction participant applies. Every DO admits against an 8,000,000,000-byte accounted ceiling, with explicit write/index/projection, WAL, migration, and headroom estimates. A deterministic simulator accounts 1 TB across virtual entities without writing synthetic payloads; it is not a physical 1 TB capacity or throughput claim.

The models in [`specs/`](../../specs/README.md) make the visibility and split/cutover assumptions executable with PlusCal and TLC. Passing those small models is a design check, not proof of the implementation.

## Context

RFD0003's historical checkpoint used one graph coordinator and four entity-hash leaves. At that checkpoint, `poneglyph/src/storage/keys.ts` fixed the shard count in both routing and object names. That topology was intentionally small enough to establish transaction visibility, versioned reads, and bounded distributed Datalog; changing a modulo count after writes would remap every entity without moving its state.

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

The subsections below retain the original A design contract and its historical single-coordinator placement. For the current source's four actor boundaries, use the four-role amendment above and RFD0005's current direction; in particular, `GraphCoordinatorDO` is the stateful facade for the cached safe-read vector/frontier, `GraphLedgerDO` owns transaction decisions, and `GraphTreeDO` owns per-owner visibility and coordination. The routing, capacity and split constraints remain relevant where they do not depend on that old placement.

### Routing and directory

1. Compute a stable virtual key as `SHA-256(graphId || 0x00 || canonicalEntityUri)`. The 256-bit key is independent of the physical shard layout. A sparse binary prefix tree partitions this keyspace: an active leaf owns one prefix range; a router node owns two child-prefix pointers. A split consumes the next hash bit and replaces one leaf with two narrower ranges. This has no configured leaf-count limit in the application. The finite hash namespace, Cloudflare account quotas, and one-entity locality remain real limits; this is not literal infinity.
2. Route by following the prefix tree from the deterministic root `GraphShardDO` name. Each node records `{graphId, prefix, generation, role, splitEpoch, child prefixes, migration state}`. A leaf split turns that node into a two-pointer router and creates child leaves; later child splits recurse, so router metadata remains constant-sized and the directory is not a flat list. The separate `GraphCoordinatorDO` stores `visible_seq`, `directory_epoch`, the writer/topology reservations, bounded transaction outcomes, read leases, and one row per in-flight split; it stores no fact log and no all-leaf routing table. Router and leaf roles currently share one class and SQL schema.
3. A query resolves routes against its leased directory epoch; field-only scans recursively enumerate at most 256 leaves. Transaction planning resolves every fact key, groups by owner, and sends `{prefix, generation, directoryEpoch}`. The coordinator rechecks the epoch and topology lock in the same local transaction that reserves the writer. A participant accepts writes only when its persisted role/generation is the active leaf; stale/fenced requests fail before apply. There is no cross-request route cache in this implementation.
4. Routing IDs and the directory format are versioned. Existing fixed-v1 objects are never silently reinterpreted under new routing. A future explicit importer must enumerate v1 facts, verify them in v2 ownership ranges, and cut over an explicitly versioned root. This prototype does not implement that importer: schema initialization rejects an unversioned namespace, and the demo starts with a fresh v2 graph.
5. Directory and data leaves use separate roles and bounds. A prefix split can create child data leaves and router metadata. If the children would remain over the operating target, split the heavier child again. If the prefix has no useful entropy or one entity dominates the range, fail closed with a capacity error rather than claiming that a split succeeded.

In the historical A design, the graph coordinator was a serialized per-graph write/visibility authority. Hierarchical routing removes the fixed leaf-count and flat-directory-size limit, but does not remove the coordinator's write-throughput ceiling. The current source instead uses per-owner gates and one short facade transaction per safe-vector publication; that changes this historical placement but does not imply an unbounded coordinator or write-throughput ceiling.

### Fact model and derived views

A write batch has a caller-provided `txId` and a non-empty list of typed fact drafts. Each draft contains `source`, `entity`, and `field` URIs, a tagged value, and a `retraction` flag. The value variants are `null`, `text`, signed 64-bit `number`, `boolean`, `bytes`, `reference`, `date`, `date_time`, `list`, and `map`; collection values may nest to a bounded depth. Stored facts add a unique `factId`, statement time, and the committing `txId`.

The append-only `fact_log` is the durable source of truth. A new assertion records evidence; a correction does not rewrite the earlier row. A retraction is itself a new fact and targets an active assertion with the same `(source, entity, field, value)` tuple. Retracting a tuple that is not active rejects the entire transaction. An entity's current field map and the active-fact/value indexes are versioned projections of the log, not competing sources of truth. The entity projection applies an assertion as the current value for its field and removes it on a matching retraction; the fact and index projections can be rebuilt by replay. An entity's facts remain co-located on one leaf, so a pathological hot entity cannot be split across ranges.

The bounded query layer maps positive binary relations to the active-value projection and unifies values across clauses. It does not query the append-only log for ordinary current-state reads, and it does not expose historical/as-of queries. This is an implementation contract, not a user-facing recommendation to treat every application datum as a single-value entity field.

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

The transaction model abstracts a transaction's effects to the set of participants containing them. The split model checks one fenced parent snapshot, idempotent pages to two children, old-route rejection, and post-cutover writes; actual nested splits, concurrent readers, lookup races, interrupted imports, and recovery against DO storage remain integration-test obligations. Crashes interrupt atomic protocol steps; durable decision/progress/route/lease state survives, and recovery is an idempotent transition rather than TLC machine state modeling volatile Worker memory.

Install a JDK and use pinned [TLA+ tools 1.8.0](https://github.com/tlaplus/tlaplus/releases/tag/v1.8.0), JAR SHA-256 `7beec0f04818732a62fa193731711a99aa4f11279499b2360a7d156c519ea78d`. Do not commit the JAR. `specs/check.sh` translates temporary PlusCal copies and runs TLC with the checked-in `.cfg` files; generated translations/state remain outside the repository.

The historical visibility/split models intentionally abstract away actual SQLite state, Cloudflare request delivery and detailed network duplication, Byzantine faults, multiple overlapping writers, abort/cancel behavior, timer/lease-expiry races, bounds arithmetic, real hash distributions, liveness under Cloudflare scheduling, and worker/network failures beyond interruption between durable steps. The read-vector experiment below includes overlapping writers but retains its own narrower omissions. Passing TLC does not substitute for TypeScript fault-injection tests. The model and implementation contracts must be updated together if implementation reveals a counterexample or changes the protocol.

### Exploratory MAV+ read-vector model (2026-10-17)

“MAV+” is the implementation candidate inspired by Jepsen's Monotonic Atomic View model; the label describes the intended profile, not a broad consistency certification. It means transaction-closed captured cuts, a globally monotonic safe-read frontier, and inclusion of every acknowledged write in a query that starts afterward. `ReadVectorRecovery.tla` names the checked property `MAVPlus`; its fairness-qualified progress clause is a separate liveness condition, not part of Jepsen's model definition. The source now implements the gated publication/cache order below, but the bounded model and focused tests do not prove the full Cloudflare protocol.

[`specs/ReadVectorPublication.tla`](../../specs/ReadVectorPublication.tla) is a coarse PlusCal design experiment, not the current implementation contract. It compares reservation-time owner tickets and per-owner maximum publication with a gated, transaction-closed vector. It models two owners (A/B), T0 spanning both, T1/T3 as distinct-entity writes on A, and T2 on B. Reader capture copies the coordinator's cached vector and registers one vector pin in one transition; scanning follows separately and does not hold publication gates.

`specs/check-read-vector-publication.sh` checks that model, the refined recovery model, and intentional counterexample configs. The coarse gated model checked 424,784 distinct states (1,722,559 generated, maximum depth 46). The naive model intentionally violates `ClosedFrontier`: T0 has A:1/B:1 in flight, T1 publishes A:2, and the vector becomes `{A:2, B:0}`. Expected counterexamples also witness disjoint A/B finalizers and a read lease captured during finalization. `specs/ReadVectorRecovery.tla` is the more implementation-shaped candidate: it starts after the irrevocable decision and all participant prepares, acquires gates in canonical owner order, assigns each local revision, applies each participant at that revision while gates are held, atomically merges the full vector at the coordinator, releases gates, then acknowledges. Its durable state separates owner gate acquisition from ledger confirmation and supports retry after any persisted step. It checked the `MAVPlus` property over 130,549 distinct states (431,392 generated, maximum depth 41), including closed-frontier, no-deadlock, query/ack safety, and eventual acknowledgement under weak fairness of protocol/recovery steps. Disjoint owner transactions can finalize concurrently; writes on disjoint entities within one owner can prepare concurrently, but their final commit-apply/publication is serialized briefly by that owner's gate. Production source now separates reservation tickets from local publication revisions, persists an owner gate, uses those revisions for shard MVCC, merges the complete owner patch plus frontier atomically in `GraphCoordinatorDO`, and holds gates through that merge and its recovery boundary. Query capture reads the fixed sixteen-root cache once and then pins selected owner components; tree fan-out remains a fixed parallel lease-registration step. Focused regressions cover same-owner serialization, multi-owner one-frontier publication, lost owner-publication and cache-publication replies, partial gate acquisition, idempotent gate recovery and abort cleanup, schema compatibility, and exact cached-component leases. Not yet established: Cloudflare RPC loss/scheduling, alarm/restart behavior beyond Miniflare, production history-pruning races, expired-lease behavior under Cloudflare scheduling, or topology transitions in production; no deployment or claim of broad consistency certification follows from this source change.

This is bounded protocol evidence, not implementation verification. Recovery abstracts a crash as stuttering and retries durable idempotent steps; actual Durable Object alarms, uncertain RPC behavior, abort cleanup, version retention/pruning, topology changes, and Cloudflare scheduling are not verified. The current source still uses reservation tickets, entity locks, and read leases; no source consistency behavior changed.

The 2026-10-17 run used the then-current official upstream `v1.8.0` rolling pre-release asset (TLC `2026.10.15.145915`, revision `932d35e`, SHA-256 `15d103b7e5617780bcc904c0af12f1ad242e2b345c0301136c5be4588f17edac`). This differs from the older JAR digest above because the upstream release URL is a rolling pre-release. Verify the JAR digest before reproducing; no tool JAR is committed.

## Cloudflare quotas and costs

Cloudflare currently documents a 10 GB SQLite database maximum per DO and no hard maximum number of DOs per namespace, while noting account/plan limits and usage-based charges [CF2–CF4]. Those provider statements are not a guarantee of unlimited aggregate storage or a user-specific quota. At the current published Workers pricing page, SQLite DO storage has 5 GB-month included on the paid plan and is $0.20/GB-month above that; row reads/writes and DO compute/request-duration are billed separately. The published paid-plan table currently includes 25 billion reads/month and 50 million writes/month before its listed overage rates ($0.001/million reads and $1/million writes). At a simplified decimal 1,000 GB-month, storage alone would be roughly **$199/month** after 5 GB-month included, before index amplification, temporary split copies, rows written/read, requests, CPU duration, and account-specific terms. This is arithmetic from the published rate card, not a cost estimate for the benchmark. Free-plan and account-specific limits differ; the effective plan and billing dashboard must be checked before the bounded deployment.

For the bounded 2026-10-11 validation, the account subscription list showed an existing `Workers Paid` plan at $5/month before and after the run (21 subscription records both times); no new subscription was added. Billing-history and metered-usage API reads returned HTTP 403 under the available CLI authentication. Therefore no incremental usage charge can be confirmed and the result must not be reported as $0. The small test recorded request latency, query scan/fan-out/tuple/byte counters, and transaction/query outcomes, but did not capture individual DO `databaseSize`, aggregate namespace storage, CPU duration, or SQL row read/write billing metrics. This run does not calibrate the 8 GB estimator or establish physical storage usage.

Before any larger or longer deployment, obtain a billing/usage view and DO storage telemetry. The user-authorized smoke was capped at 10 single-shard transactions, 10 cross-shard TODO moves, and 10 query requests per topology; its actual usage was not independently visible through the available billing API, so no zero-charge or included-quota conclusion is asserted. This small bounded run does not justify an unbounded test when detailed billing visibility is unavailable. See the operational evidence and cleanup procedure below.

## Bounded isolated Cloudflare validation (2026-10-11)

The expandable version was deployed only as `poneglyph-scaleout-validation-20261011` at `poneglyph-scaleout-20261011.poneglyph.leostera.dev`, with `workersDev` disabled and three temporary SQLite DO classes. The authenticated TODO smoke rejected unauthenticated HTTP/WebSocket access, performed a two-participant task move, received matching invalidations on two authenticated clients, and re-queried the destination list at the published commit sequence. The generic smoke verified a four-fact commit, same-`txId` replay, and a four-row query. A 10-transaction / concurrency-2 sample measured 3.41 tx/s single-shard and 2.44 cross-shard TODO moves/s; query latencies and counters are tabulated below. Five query samples per shape make p95/p99 equal the observed maximum, so they are not meaningful tail estimates. These public-network results are exploratory and are neither an SLA nor physical capacity evidence.

Cleanup deployed the class-deletion mode, deleted the dedicated Worker, and verified no matching script, DO namespaces, Worker-managed DNS record, secret, or certificate pack remained. The generated certificate pack disappeared asynchronously after a `pending_deletion` state; no unrelated account resources were changed. A startup-only atomic schema-kind/version marker and fail-closed guard was added after this account run; it passed local workerd tests/build but was not redeployed. The transaction, migration, and query paths measured here were unchanged. The prior fixed-leaf Cloudflare run remains a separate historical record and is not included in these results.

## Public client and Worker API

The experimental `@leostera/poneglyph` package exports portable fact/value/identifier types, `ParseResult` parsers, bounded Datalog AST/value/evaluator and `FactSource` APIs, and a typed HTTP client. It does **not** bundle the SQLite Durable Object storage runtime as a direct embedding API. Downstream applications use an authenticated HTTP endpoint or service-binding adapter; direct SQL access and internal DO class imports are not supported public contracts. Earlier Rust embedding APIs remain historical only.

```ts
import { createDatabase, type FactInput } from "@leostera/poneglyph";

const db = createDatabase({ url: "https://your-worker.example" });
const graph = db.defineGraph({ id: "team-memory" });
const facts: readonly FactInput[] = [{
  source: "agent:team-memory",
  entity: "team:task:one",
  field: "team:task:title",
  value: { type: "text", value: "First task" },
}];
const {txId} = await graph.transact(facts, {clientRequestToken: "team-memory:seed-1"});
const result = await graph.query('team:task:title(Task, "First task")');
```

`createDatabase` and `defineGraph({ id })` are synchronous local constructors; neither registers a graph nor makes a network request. `defineGraph` accepts only an ID, not a schema: the Worker has no persisted graph catalog/schema enforcement. A default `graphId` in database configuration exposes the same graph methods directly on `db`. Configure `headers` and injected `fetch` for application authentication or a service-binding adapter. Headers alone do not secure the Worker; the generic graph routes are not automatically protected by the TODO demo's session rules. URLs must be absolute HTTP/HTTPS, without credentials, query, or fragment; a path prefix is retained.

| Client method | Result and boundary |
| --- | --- |
| `transact(facts, options?)` | Returns exactly `{ txId }` after the service validates a committed transaction witness. |
| `query(source, options?)` | Validates Datalog source locally and returns buffered `{ rows, snapshotSeq, metrics }`. |

`FactInput` accepts an optional retraction flag, normalized to false when omitted/nullish; the shared fact parser checks the complete batch before transport. Write options accept an optional `clientRequestToken` and `AbortSignal`; query options accept `AbortSignal`. The service generates each internal transaction ID and exposes it only in the successful receipt. A token is a non-empty string of at most 256 UTF-8 bytes, scoped to the graph; its durable mapping is retained for seven days subject to bounded capacity. Same-token/same-facts retries, including concurrent duplicates, return the original `{ txId }`; changed facts conflict. Without a token, each submission is a new transaction. The client never retries automatically. After ambiguous delivery, only retry the same logical operation using the same token and exact facts. Internal sequence/ticket state remains private and is not a graph-global API clock.

- `PoneglyphInputError`: invalid graph/fact/query input, optionally with parser path/offset. Invalid configuration can instead throw `TypeError`.
- `PoneglyphNetworkError`: fetch/body-read failure with cause; the commit outcome may be unknown and no internal ID is exposed.
- `PoneglyphRequestError`: HTTP failure with status, retryable hint and optional raw `retryAfter`. A boolean server hint overrides inference; otherwise 408/423/429/5xx are retryable. A string such as `"false"` is not a boolean hint.
- `PoneglyphProtocolError`: malformed successful response/receipt/query binding; not proof of abort.

Query rows are parsed/frozen Datalog bindings, not a streaming cursor. Snapshot sequence and access counters must be nonnegative safe integers. Metrics are `scanCalls`, `shardRequests`, `tuplesRead`, `bytesRead`, and `directoryRequests`, plus the optional elapsed `timing` group specified in the query execution amendment. The API has no pagination, query objects/builders, `query(txId, query)`, or historical/as-of contract. Latest/read-token/stable-snapshot product questions remain deferred. More clients do not remove the single graph coordinator; multiple graph IDs create separate graphs, not transparent partitioning. Cloudflare's approximately 1,000 requests/second per DO is a soft workload-dependent limit, not a hard ceiling or Poneglyph throughput claim.

The HTTP routes are:

```text
POST /v1/graphs/{graphId}/transactions  { "facts": [...], "clientRequestToken": "optional" }
POST /v1/graphs/{graphId}/query         { "query": "..." }
GET  /v1/graphs/{graphId}/entities?uri=wiki%3Acrew%3Astraw-hats
```

Transaction drafts contain source/entity/field URIs, a tagged value such as `{ "type": "reference", "value": "wiki:person:luffy" }`, and explicit `retraction` at the HTTP boundary. The public write envelope accepts facts and an optional `clientRequestToken`; it rejects caller-supplied transaction IDs. Graph IDs are lowercase slugs of at most 64 characters. Shared parsers return typed `ParseResult` values rather than silently coercing malformed input. Parsing facts or queries alone persists nothing. See [`src/client.ts`](../../packages/poneglyph/src/client.ts), [`src/index.ts`](../../packages/poneglyph/src/index.ts), and [`client quickstart`](../../examples/client-quickstart/src/main.ts).

### Package construction and publishing gates

The scoped name is used because the unscoped npm name is taken. The [package manifest](../../packages/poneglyph/package.json) sets public access, runs local checks in `prepublishOnly`, and builds ESM JavaScript/declarations into `dist/` in `prepack`. These settings are not publication authorization.

```sh
bun install --frozen-lockfile
bun run build:package
cd packages/poneglyph
npm pack --dry-run
```

Use the private/local package artifact for development and benchmarks. After an intentionally authorized release consumers can install `@leostera/poneglyph`. Publishing requires an authorized scope account and fresh version, but this repository currently has no `LICENSE` file or license metadata. Choose/add the intended license and explicitly authorize publication before running `npm publish --access public`.

## Datalog grammar and access paths

Queries are conjunctions of positive binary relations (`field(Entity, Value)`) and pure constraints. Terms are uppercase-leading variables, `_` in fact relations, URI/string constants, quoted strings, and signed 64-bit integer literals. Repeated variables unify. Top-level list values expose one relation tuple per member, matching the Poneglyph/Datafox conversion rule. Builtin variables must be bound by a positive relation. Supported constraints are `=`, `<`, `<=`, `>`, `>=`, `eq`, `lt`, `lte`, `gt`, `gte`, `before`, `after`, `contains`, `startsWith`, and `endsWith`.

The parser rejects negation, recursive rules, non-binary relations, arbitrary expressions, unsupported builtins, unbound builtin variables, queries without a positive relation, more than 64 clauses, and text over 8 KiB. Positive relations run in source order as a streaming nested-loop join; constraints filter completed bindings. Leaves emit NDJSON tuples, merged concurrently and joined incrementally; final JSON buffers only within byte/result caps. Ordering is not promised, and there is no general-purpose optimizer or global text index.

| Bound terms | Routing | SQLite index |
| --- | --- | --- |
| field only | every active leaf, at most 256 | `active_values_by_field_snapshot` |
| field + entity | one leaf through prefix routers | `active_values_by_field_entity_snapshot` |
| field + value | every active leaf, at most 256 | `active_values_by_field_value_snapshot` |
| field + entity + value | entity's leaf | `active_values_by_field_entity_value_snapshot` |

Integer literals map to numeric facts. URI-looking strings map to references except in `wiki:page:title` and `schema:name`; other strings map to text. A value constraint alone does not route to one leaf. Unbound-entity scans are proportional to active leaves plus matching rows. Budgets are 2,000 results, 50,000 tuples, 20,000 shard requests, 20 MB scanned response bytes, 2 MB serialized result bytes, 20 seconds, 128 concurrent read leases, 256 leaves, and 511 directory visits. Budget failure is an error, never silent truncation. An unsplittable entity is limited to 10,000 active assertion tuples and 5,000 projected fields.

## Authenticated reactive TODO operating contract

`GET /todo` serves the shared UI. Set `TODO_SHARED_PASSPHRASE` only as a Worker secret or a throwaway local `.dev.vars` binding (ignored by Git); never reuse the test passphrase from `vitest.config.ts` on Cloudflare. The Worker fails closed without the secret. Login compares bounded SHA-256 digests without early-exit byte comparison, then issues a one-hour HMAC-signed `Secure; HttpOnly; SameSite=Strict` cookie. The phrase is not embedded in the page, stored in a DO, or sent in a WebSocket URL.

Protected TODO HTTP routes and direct reads of `todo-shared-2026` require the session. Generic transaction writes to that graph are denied so mutations cannot bypass invalidations. WebSocket handshakes require the cookie and exact same-origin HTTPS Origin; loopback HTTP is allowed locally. The demo's two list entities (`todo:list:todo`, `todo:list:done`) route to opposite root children. A move is one transaction retracting old membership and asserting destination/task membership. Two-client integration tests verify two participants and query-visible notification sequences.

The hibernatable `TodoHubDO` receives an invalidation only after commit acknowledgement. Delivery is best-effort, errors are logged, and clients refresh on reconnect. There is no durable outbox; a missed signal never rolls back facts. A production notification service needs a separate durable delivery contract.

## Local operating and review gates

### Bun workspace layout (2026-10-14)

The maintained TypeScript packages now live under `packages/`: `poneglyph` (library/client/database Worker), `conformance` (independent correctness harness) and `write-path-bench` (private performance harness), plus six private example packages under `examples/<name>/`. `packages/*`, `examples/*` and the later `sites/*` applications belong to the root Bun workspace. [RFD0006](./RFD0006-public-read-only-mcp-playground.md) records the public read-only Agents SDK playground, its private database boundary, rate limits and pending deployment/load. One private root workspace manifest and `bun.lock` replace three independent pnpm installations. Bun1.4.2 owns dependency installation and script orchestration; Node26 still runs Cloudflare/Vitest/Miniflare tooling, process-group hosts and the `node:sqlite` reference ledger. Do not force these through `bun --bun` or substitute Bun's built-in test runner.

Each standalone example owns a manifest, strict typecheck, ESM build, offline tests and an explicit `run` command. Root build/check/test gates include them sequentially through the `@poneglyph/example-*` workspace filter and fail on the first failed package. Entry modules guard effects with `import.meta.main`; importing source/built code for tests never starts a cloud smoke test, native Worker or corpus load. Example tests use injected/mocked HTTP, local event emitters, synthetic accounting or tiny XML fixtures. These are example regressions, not additional conformance cases or hosted/dataset/performance certification. Manual run commands remain separate and subject to the existing resource/load authorization gates; no copies/aliases remain under `packages/example-*` or in the core package scripts.

The private harnesses depend on `@leostera/poneglyph` via `workspace:*`, consuming its built exports rather than copied `file:` packages. Root typecheck/check scripts build the portable package before consumers and generate Worker types first. The publishable package name/version/exports, storage schema7/routing8, object names, limits and protocols are unchanged; the root and harnesses stay private. Existing pnpm resolutions were merged and migrated into the root Bun lock rather than intentionally upgrading dependencies. Only the existing esbuild/workerd lifecycle scripts are explicitly trusted. No dependency/package-management layout migration authorizes publication, deployment, benchmarking or namespace conversion.

Archived reports/bundles/persistence move intact with their harness packages. Their recorded revisions, paths and hashes remain immutable, even where old absolute paths no longer exist. Updated documentation links locate the relocated evidence; moving it is not native recovery or rerunning an experiment. Newly built harness identities hash the root workspace manifest and lockfile. Git retains the original paths at their historical revisions.

### Example review checkpoint (2026-10-14)

Following package validation, three focused `leo-code-*` passes reviewed workspace/example boundaries—not a speculative storage redesign or exhaustive review of every production path:

1. **Readability/types:** replaced positional write-count arguments with a named immutable `WriteWorkload`; callbacks require a committed response, stop admission on first failure and drain admitted peers before surfacing the original cause (`99ffb7d`). Missing status, invalid workloads and causal failure/drain fixtures are explicit regressions.
2. **Parsing/invariants:** deployed examples require an explicit credential-free approved origin, parse configuration before network effects and no longer silently retry uncertain transport (`dbb714f`). The generic smoke uses public client receipt/row/metric parsers and exact typed answer multisets. Removed unproved one-root/participant-count and graph-global scalar-clock assertions; fresh-graph reports no longer call that graph one physical shard.
3. **Clean cutover/resources:** removed the XML parser assertion wrapper in favor of its real declared types; the XML example uses public client receipt/query parsing without equating batch ordinals to global commit sequences. Percent-encoded exact titles prevent case/punctuation/Unicode collisions; this changes newly generated example identities, not historical corpus hashes/reports. Configuration is loaded explicitly at execution, not import. Incomplete local-load persistence is retained. Socket message/error/close paths settle the original waiter and release owned timers/listeners; the demo drains admitted notification waits and cleans the first socket if the second connection fails.

Final root frozen install, typechecks, package/Worker/example builds and **194 unit/adapter/example tests** pass; the sole skip is the opt-in historical benchmark. Of these, **31** are example regressions using fake transports, local emitters and tiny/synthetic fixtures. Two initial quickstart test-fixture errors (omitted required metrics, then plain-object versus the client's prototype-free binding representation) were repaired without weakening client parsing; original command diagnostics remain outside the product. No cloud/load/manual example or new full68-case run is implied. The earlier relocated full gate is source-identified separately in RFD0005; the production storage implementation is unchanged by these focused passes. This checkpoint does not certify natural idle eviction, elapsed retention, physical capacity, hosted performance or every remaining correctness case.

`packages/poneglyph/cloudflare.config.ts` is the deployment/runtime config for the canonical validation Worker; site applications own separate configs as described in RFD0006; `vite.config.ts` registers the Cloudflare Vite plugin, and `vitest.config.ts` configures local Miniflare/SQLite tests without a Wrangler config. Compatibility date is `2026-10-06`; the recorded types identify `workerd@1.20261006.1`. Keep the cf CLI, plugin, and compatibility date aligned. The CLI delegates bundling to Vite; Wrangler is not a direct configuration/dependency, although test tooling may have internal dependencies.

```sh
# Repository root:
bun install --frozen-lockfile
bun run check                           # all workspace types + unit/adapter suites
bun run build                           # portable package + local Worker bundle
bun run test:focused                     # focused warm/cold E2E regressions
# bun run test:small                     # deliberate full declared-case checkpoint
# bun run test:capacity                  # optional synthetic accounting, no payload writes
bun run dev                             # optional local Vite/workerd server
```

Cloudflare's cf CLI may warn that auto-configuration is limited when it sees no lockfile inside the package directory; the explicit config still builds successfully. Keep the one root lockfile—do not add a nested lockfile to suppress the warning. Use `bun run --cwd packages/poneglyph <script>` for package-specific commands.

Tests use fresh graph IDs and no account resources. `bun run --cwd examples/onepiece-load run` is the separate legacy local corpus/query gate described below, not the concurrent comparison. The formal gate uses `TLA2TOOLS_JAR=/path/to/tla2tools.jar ./specs/check.sh` from the repository root. Normal/cleanup dry runs, model checks, and workload tests are historical validations unless explicitly rerun for the revision under review; do not report them as freshly executed merely because documentation moved.

The corrected revision's latest recorded `pnpm check` passed 39 tests, one optional benchmark skipped, and its write-path harness passed six tests. RFD0005 records four 100k cases passing admitted-write fact/index/transaction and restart audits but failing full delivery. The earlier pre-client operating snapshot had 28 passing tests and one skipped. These scoped checks are not universal implementation proofs; the corrected revision was not deployed to Cloudflare.

Review the following invariants: append-only facts/retractions; publication after every participant applies; one pinned sequence/epoch per read; fenced, idempotent copy verified before irreversible cutover; old-owner retention through lease drain; conservative database/WAL/import/headroom accounting; explicit request/storage/query/outcome bounds; atomic schema-kind/version initialization with fail-closed incompatible namespaces; post-commit-only, best-effort TODO notifications. Automatic schema evolution/import is not implemented: use fresh namespaces/graphs unless an explicit importer is separately provided. Do not modify FokosDB, unrelated `.pi/` content, or unrelated Cloudflare resources.

## Recorded local operating workloads (2026-10-11)

These samples predate the corrected concurrent baseline in RFD0005. They are local exploratory evidence, not cloud performance or the current comparison matrix.

### Small throughput/query sample

`pnpm bench:local` runs one unsplit and one root-split topology with temporary Miniflare SQLite. Defaults are 40 transactions per topology, three facts/two entities per transaction, 40 queries per topology (20 scans and 20 joins), and concurrency four. Retry latency includes same-ID/payload busy backoff. `PONEGLYPH_BENCH_TRANSACTIONS`, `PONEGLYPH_BENCH_QUERIES`, and `PONEGLYPH_BENCH_CONCURRENCY` are bounded by the script. Output includes tx/fact/entity rates, QPS, latency, and shard/scan/tuple/byte/directory costs.

| Topology / shape | tx/s / facts/s / entities/s | Write p50/p95/p99 ms | Query QPS | Query p50/p95/p99 ms | Scans / shards / tuples / bytes / directory |
| --- | --- | --- | ---: | --- | --- |
| single leaf | 87.34 / 262.01 / 174.67 | 17 / 165 / 227 | — | — | — |
| single leaf scan | — | — | 30.49 | 9 / 23 / 24 | 1 / 1 / 80 / 6,320 / 1 |
| single leaf join | — | — | 30.49 | 116 / 130 / 131 | 41 / 41 / 80 / 6,840 / 41 |
| two leaves | 85.29 / 255.86 / 170.58 | 27 / 101 / 198 | — | — | — |
| two leaves scan | — | — | 25.87 | 13 / 15 / 18 | 1 / 2 / 80 / 6,241 / 3 |
| two leaves join | — | — | 25.87 | 134 / 153 / 154 | 41 / 42 / 124 / 10,185 / 55 |

Source-order joins cause repeated scans; the counters expose that cost. Tiny synthetic local samples are noisy and not directly comparable to the corpus workload.

### Legacy One Piece load/query sample

[One Piece example](../../examples/onepiece-load/src/main.ts) streams cached MediaWiki XML into a temporary `cf dev` instance, discovers its Vite URL, and runs four queries from [deployed smoke example](../../examples/deployed-smoke/src/main.ts). It writes up to 500 facts/800,000 estimated fact bytes per transaction (server canonical cap remains 1 MB), adds deterministic crew/island/lore fixtures to real page titles/categories/links, and retains the dump cache while stopping the local process/removing temporary SQLite state. It is a workload, not a wiki connector or RFD0005's packaged-client concurrency benchmark.

```sh
# From repository root; cache is ignored by Git.
PONEGLYPH_ONEPIECE_DUMP_SHA256=c4e33cc6793425d9baa5f76a9f12f047d75dec135006093ed9357629a7d1f7bb \
  ./tests/fixtures/download_onepiece_fandom.sh
cd poneglyph
PONEGLYPH_ONEPIECE_MAX_PAGES=20000 PONEGLYPH_ONEPIECE_QUERIES=10 pnpm test:onepiece
```

`PONEGLYPH_ONEPIECE_XML` overrides the XML path; `PONEGLYPH_ONEPIECE_ARCHIVE` identifies its archive for hash reporting. Default page limit is 5,000; zero attempts the full dump. The mutable current URL requires checksum pinning to expose drift; neither XML nor archive is checked in. Output includes hashes, pages/facts/transactions, load rate, access metrics, and warm median/p95.

The recorded Apple M4 Pro/12-core sample used Node 26.11.0, pnpm 12.10.1, `cf@1.0.0-beta.14`, Cloudflare Vite plugin `2.0.0-beta.sha-91c870c02`, Vite 8.3.4, and compatibility date `2026-10-06`. Input was a 20,000-page prefix of 436,781,838-byte XML, SHA-256 `1446ff8fca4bdebd289e5a546d67078d1170369fb3bfb65a35c758d53cd4e084`, archive SHA-256 as above. It committed 159,332 facts in 320 transactions in 618.19 seconds (257.74 facts/s), slower than the historical fixed-leaf checkpoint. All queries/replays used snapshot 320. No physical DB size was captured; temporary state was removed.

| Query | Rows | Scans | Shard requests | Tuples | Bytes | Directory | Warm median/p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| captains/seconds, 5 clauses | 12 | 34 | 34 | 45 | 4,533 | 19 | 133.73 / 184.75 |
| islands/leaders, 3 clauses | 7 | 15 | 15 | 21 | 2,071 | 15 | 102.21 / 109.45 |
| Joy Boy-to-Luffy, 6 clauses | 1 | 12 | 12 | 12 | 1,245 | 6 | 88.21 / 130.94 |
| names containing ` D. `, 2 clauses + builtin | 9 | 669 | 669 | 1,346 | 116,018 | 669 | 2,302.69 / 3,073.49 |

The old ASCII slugger is not injective, so the captain query can include more than six fixture crews; it is not a production identity strategy. RFD0005's percent-encoded corpus fixes identities independently. Query order/wall-clock values are not stability promises.

## Isolated Cloudflare procedure and detailed evidence

The recorded expandable-topology validation used only `poneglyph-scaleout-validation-20261011`, custom domain `poneglyph-scaleout-20261011.poneglyph.leostera.dev`, and three class namespaces (`GraphCoordinatorDO`, `GraphShardDO`, `TodoHubDO`). Worker, hostname, DNS record, and certificate pack were absent beforehand. The 256-bit random TODO passphrase was held only in the shell and Worker secret, never printed or committed. `workersDev` was disabled.

After certificate activation, `pnpm test:deployed:todo` checked page serving, 401 for unauthenticated HTTP, bad passphrase and unauthenticated WebSocket, and matching invalidations to two authenticated clients for a two-participant move. The move committed at sequence 6; the shared graph began the measured smoke at snapshot 4 because earlier smoke writes existed. A generic smoke committed/replayed four facts and queried four rows at snapshot 1.

The benchmark used 10 single-shard transactions (3 facts/2 entities each), 10 cross-shard moves (4 facts/3 touched entities each), concurrency two, and 10 queries per topology (five per shape). It seeded 10 tasks before timing moves; final TODO snapshot had 13 tasks at sequence 26, including three from earlier smoke invocations.

| Workload | Elapsed | tx/s | facts/s | entities/s | Write p50/p95/p99 ms |
| --- | ---: | ---: | ---: | ---: | --- |
| 10 single-shard transactions | 2.93 s | 3.41 | 10.24 | 6.83 | 566.76 / 1,358.45 / 1,358.45 |
| 10 two-participant TODO moves | 4.10 s | 2.44 | 9.77 | 7.32 | 383.13 / 2,522.48 / 2,522.48 |

| Query, five samples per shape | QPS | p50/p95/p99 ms | Scans / shards / tuples / bytes / directory |
| --- | ---: | --- | --- |
| single-shard scan | 3.95 | 131.77 / 138.95 / 138.95 | 1 / 1 / 20 / 1,630 / 1 |
| single-shard join | 3.95 | 338.13 / 381.36 / 381.36 | 11 / 11 / 20 / 1,800 / 11 |
| TODO membership scan, two leaves | 2.43 | 166.03 / 188.33 / 188.33 | 1 / 2 / 13 / 1,443 / 3 |
| TODO task join, two leaves | 2.43 | 518.79 / 716.13 / 716.13 | 14 / 15 / 26 / 2,988 / 29 |

Five latency samples make p95/p99 equal the maximum, not meaningful tail estimates. Public network/Worker/DO overhead is included. No individual DB sizes, aggregate storage, CPU duration, physical capacity, or SQL billing metrics were captured. The schema guard and later RFD0005 correctness changes were not deployed; these historical results must not be attributed to the corrected revision. The startup-only schema guard passed local tests/build after the run; measured data paths then were unchanged.

### Deployment, secret handling, and cleanup safety

Before another deployment, verify account identity with `pnpm exec cf auth whoami`, names/host collision, effective plan and limits, usage visibility, and approved request/storage/duration/cost caps. Use fresh uniquely named temporary resources under `*.poneglyph.leostera.dev`; do not blindly redeploy the recorded names. The existing config is the previous validation setup, not RFD0005 benchmark deployment configuration. Pass local gates first. Billing/usage API reads previously returned 403, so obtain an agreed bounded budget if visibility remains unavailable; never claim zero charges.

The following records the old expandable validation procedure. Adapt its exact resource names/configuration only for an approved isolated run; deployment and teardown require authorization. Generate the phrase in the active shell, never echo/save/commit it, and unset it afterward:

```sh
cd poneglyph
pnpm deploy
export PONEGLYPH_TODO_PASSPHRASE="$(openssl rand -hex 32)"
pnpm exec cf workers secrets update TODO_SHARED_PASSPHRASE \
  --worker poneglyph-scaleout-validation-20261011 \
  --type secret_text --text "$PONEGLYPH_TODO_PASSPHRASE"
sleep 20 # allow secret version propagation; wait for HTTPS certificate active too
pnpm test:deployed:todo
PONEGLYPH_CLOUDFLARE_TRANSACTIONS=10 \
PONEGLYPH_CLOUDFLARE_QUERIES=10 \
PONEGLYPH_CLOUDFLARE_CONCURRENCY=2 pnpm bench:cloudflare
pnpm test:deployed
unset PONEGLYPH_TODO_PASSPHRASE
# Destructive: only after cleanup approval for this exact deployment.
pnpm exec cf deploy --mode cleanup
pnpm exec cf workers delete poneglyph-scaleout-validation-20261011 --force
```

Cleanup mode permanently deletes the three namespaces and their databases, then Worker deletion removes the domain/DNS binding and secret. Never use it as a harmless dry run. Verify exact-name listings:

```sh
pnpm exec cf workers scripts search --name poneglyph-scaleout-validation-20261011 --per-page 100
pnpm exec cf durable-objects namespaces list --per-page 100 | jq '[.[] | select((.script // "") == "poneglyph-scaleout-validation-20261011")]'
pnpm exec cf dns records list --zone leostera.dev --name poneglyph-scaleout-20261011.poneglyph.leostera.dev --per-page 20
pnpm exec cf ssl certificate-packs list --zone leostera.dev --status all --per-page 100 | jq '[.[] | select((.hosts // [] | tostring | contains("poneglyph-scaleout-20261011.poneglyph.leostera.dev")))]'
pnpm exec cf workers secrets list --worker poneglyph-scaleout-validation-20261011
```

The Worker, namespace filter, DNS, and certificate filter must return no matches. The secret query may return 404 after script deletion. Certificate issuance/deletion is asynchronous: wait for active before HTTPS checks and disappearance after cleanup. The recorded cleanup found no matching Worker, namespaces, DNS, secret, or certificate pack; the pack passed through pending deletion and public hostname/TXT DNS records disappeared. No unrelated account resource changed. If cleanup fails, stop and inspect the exact isolated resources rather than broaden deletion filters.

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
