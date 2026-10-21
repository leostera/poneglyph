# Local mixed Datalog traffic probe

Three opt-in Miniflare/workerd runs against the canonical implementation at `529f475`.

- Query: `traffic:correctness(Entity, "active"), traffic:label(Entity, Value)` (two same-entity clauses).
- High wave: 1,000 transactions, two append-only facts each, 32 concurrent writers; eight concurrent/interleaved reads and two final reads after actor eviction. Each sample queried all 16 roots; all directory epochs remained 0 (no split requested).
- All three high waves completed 1,000/1,000 writes and 10/10 exact queries, with 2,000/2,000 audited durable facts per wave, zero failed writes/queries, and zero query retries. Exact payload replay after ledger/facade/shard eviction preserved receipts. Writer retry counts were 1, 2, and 6.
- Caller-inclusive high-wave write p50/p95/p99 (ms): run 1 `181/751/1087`, run 2 `184/698/1264`, run 3 `151/611/1284`. Query p50/p95/p99 (ms): `136/325/325`, `112/289/289`, `103/224/224`. There were only 10 query samples per run, so p99 is the observed maximum, not a tail estimate or guarantee. Query sample snapshot sequence, epoch, fan-out, retries, and every individual timing are in `summary.json`.
- These numbers miss the sub-100-ms objective for high-load query/write p99 and are local only. The full-result unbound query is not a useful test of whether hierarchical selective joins improve performance. No candidate implementation was benchmarked; the result supports keeping the canonical baseline and deferring a query-plan prototype until a selective workload and component trace show central join/tuple transfer is the bottleneck.
- Independent focused conformance passed before these runs: 10 scenarios in warm and cold phases (20 case-phases), including owner-local bag join, partial-apply process-crash recovery, and read faults. Report: `tests/conformance/results/focused-controls-2026-10-21T07-42-49.020Z/report.json` (not full-tier certification). A subsequent root `bun run check` passed: 69 test files / 365 tests passed, two skipped each, and the persisted conformance summary recorded zero failed checks (`tests/conformance/results/2026-10-21T07-51-25.769Z/summary.json`).
- An initial test-instrumentation attempt queried the wrong DO namespace and got `no such table: graph_state`; corrected to `GRAPH_TREES`, then all three full waves passed. The failed attempt is retained in `instrumentation-failure.txt`.

Raw per-run output and source digests are retained in `summary.json`. This is not hosted evidence, capacity certification, or a production latency claim.
