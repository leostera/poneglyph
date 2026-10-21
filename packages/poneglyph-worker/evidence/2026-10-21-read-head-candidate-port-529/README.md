# Read-head candidate port tested on baseline 529f475

This is the follow-up required by the completion auditor: the read-head freshness-authority candidate was ported into an isolated worktree whose **exact HEAD was `529f4754489578610490f001c95a75f3f595d7c4`**, then rerun against that baseline. The earlier `2026-10-21-read-head-candidate/` folder records the historical a38765e experiment; it is not the evidence basis for this port.

## Port and compatibility

The gzip-compressed exact patch is retained at `source/port-529.patch.gz`; `source/source-digests.json` records compressed and content digests and every changed file. The separate worktree was `poneglyph-worktrees/experiment/read-head-port-529`, branch `experiment/read-head-port-529`, with `HEAD` left at the verified baseline and changes uncommitted/isolated. No canonical source was changed or selected.

The port adds metadata-only read-head roles, a durable journal/freeze/activate publication gate in the existing facade, and a Worker-side validator for complete cached Datalog results. The ledger remains transaction authority; owner participants still apply append-only facts; the canonical safe vector and exact tree read leases remain the fallback. A query is either the complete row bag at its exact snapshot or an error. Public APIs and fact/transaction/index data formats are unchanged. **There is one deliberate persisted control-plane change on opt-in:** the first head join changes only the `g-facade` schema marker from version 2 to 3. Candidate code accepts versions 2/3; the old marker predicate rejects 3, fencing old writers after activation. This does not rewrite graph data, but it is still a persisted compatibility marker and must be an explicit product decision before adoption.

## Correctness and build evidence

- `bun run typecheck` passed on the port.
- The independent focused oracle passed 10 cases in warm and cold phases (20 case-phases); for the 401-row multi-clause bag join, its test-only adapter joined a real head before first read and required exact replay at the same snapshot. After replacement/retraction it required stale validation to fall back before checking the refreshed full result. Report: `conformance/focused/report.json`.
- The independent small tier passed **69 cases / 138 warm+cold case-phases**, with zero failed checks; it ran with a live head active for every queried graph. See `conformance/small/summary.json` and `report.json.gz`.
- `bun run check` passed on the port: 75 test files and 408 tests passed, 2 files/tests skipped. This includes the read-head storage journal, KV/SQLite atomicity, recovery, replica, schema-compatibility, and conformance suites. The raw log is retained as `tests/root-check.txt.gz`.
- Additional candidate-specific tests: 44 storage/read-head tests passed; the Worker routing suite passed 9/9 when run directly via Node's test runner (the pre-existing suite uses `node:test`, so it was not put into the Vitest glob); raw logs are gzip-preserved under `tests/`.

## Bounded local performance

Successful run `67e89a24-b9f1-473a-b6cc-cc84f5c3b4bd` compared 0 versus 8 heads in Miniflare/local SQLite. It completed 64/64 samples in each of four measured rounds, all 256/256 steady reads exact, and 500/500 post-publication warm point reads exact at observed concurrency 128. The 0-head rounds used 64 canonical read cuts each. The 8-head rounds used zero canonical read cuts and exactly 64 fresh head validations per round, distributed across the eight members. After a two-fact write, the first refresh returned snapshot 2; the subsequent 500 reads were snapshot 2/cache hit 1, with zero canonical cuts. The one acknowledged publication took 36.62 ms.

| Shape | Heads | p50 | p95 | p99 (ms) | Completeness |
|---|---:|---:|---:|---:|---:|
| Bound point | 0 | 6.78 | 8.24 | 8.49 | 64/64 |
| Bound point | 8 | 7.27 | 7.79 | 7.95 | 64/64 |
| Five-clause combined | 0 | 29.24 | 30.57 | 30.83 | 64/64 |
| Five-clause combined | 8 | 31.38 | 32.73 | 32.93 | 64/64 |

This is one small local closed-loop run, not a tail estimate or hosted result. Combined offered concurrency was 128 but observed in-flight max was 64 in these steady rounds. The 500-read post-publication wave did reach 128. The modest point-query change and worse combined-query p99 do not establish a general latency gain, though cut-RPC elimination is directly observed. No unique-query, broad capacity, geographic, or hosted performance claim follows.

All local attempt reports, including the unconfirmed/setup failures that preceded the successful run, are retained under `local-runs/`; only the successful run supplies performance numbers. Attempts used fresh temporary namespaces and unique transaction tokens; no uncertain write was replayed.

## Formal scope and recommendation

From the port worktree, TLAPS reran six local obligations successfully and rejected all three deliberate weakened-model controls (strict SMT, TLAPM `901ae51`, Z3 4.8.9; no Isabelle certificate recheck). Historical TLC results for one/three-head publication and routing remain under `formal/historical-*.json`; a fresh TLC invocation stopped before execution because `TLA2TOOLS_JAR` is unavailable (`formal/tlc/attempt.txt`). These models are not whole-protocol proofs, implementation refinement, availability, or performance evidence.

**Recommendation: do not select for canonical storage.** The port now passes the current baseline's correctness and build gates, but a single bounded trial shows no consistent Datalog latency benefit; the design adds a synchronous all-head publication barrier and a persisted protocol-marker fence. Retain it as research, keep Candidate A canonical, and require an explicit decision on the marker migration plus representative write/read profiles and any authorized hosted evaluation before reconsideration. No Cloudflare deployment or resource operation was performed.
