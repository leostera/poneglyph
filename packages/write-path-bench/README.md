# Write-path benchmark

Benchmarks the **one canonical Poneglyph implementation**, promoted from G, under [RFD0005's current direction](../../docs/rfds/RFD0005-write-path-experiment.md#current-direction-one-implementation-2026-10-14). There is no backend tournament or selector. Historical A/B1/C–K comparisons and failed deliveries remain separately identified evidence, not runnable alternatives or certification of the current bundle. Benchmark loads remain paused until the correctness checkpoint is satisfied; cloud execution remains unauthorized. Fix defects between runs, never adapt a running workload or count unknown commits as acknowledgments.

Detailed harness parameters, extraction/audit scope, retention policy, and both final measurement tables are reflected in [RFD0005](../../docs/rfds/RFD0005-write-path-experiment.md#implementation-and-evidence-reset-2026-10-11). This README remains the runnable entry point.

## What runs

```text
local HTTP driver -> gateway -> 1..32 application Workers
                                   -> @leostera/poneglyph.stateFacts
                                   -> database Worker (service binding)
                                   -> real Miniflare SQLite Durable Objects
```

All applications use one graph in one database per trial. The gateway selects application services locally; it is not a new database coordinator. Production coordinator/shard write methods are inherited unchanged. The benchmark subclasses add read-only audit methods, reachable only by a token-protected local entrypoint. They must not be exposed on a public cloud route.

The client is a `workspace:*` dependency consuming the built package exports, not a direct import of database internals. `stateFacts` is an added client method delegating to the existing transaction protocol. No faster baseline storage path was introduced. The existing `state` method is retained.

## Reproduce locally

From the repository root:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run --cwd packages/write-path-bench test
# Only after explicit authorization to run a benchmark:
bun run --cwd packages/write-path-bench prepare:corpus
bun run --cwd packages/write-path-bench preflight
BENCH_FACTS=100000 BENCH_WORKERS=4 bun run --cwd packages/write-path-bench run:local
```

`prepare:corpus` uses the cached `tests/fixtures/cache/onepiece-pages-current.xml`, or accepts an XML path as its first argument. It prepares ordinary facts locally; there is no database import API. Exact percent-encoded titles prevent the old extractor's lossy-slug collisions. The manifest records all pages processed, the 8-category/16-link extraction caps, and omission of full wiki text. No hand-authored domain facts are mixed into the corpus.

An authorized benchmark attempts **the same first 100,000 corpus facts in every scenario** against the canonical implementation. Correctness hardening precedes new performance runs. Scaling to 1,000,000 remains a separate explicit decision. The complete prepared corpus contains **1,530,195 facts from 296,624 pages**. `preflight` is informational; it does not write data, shrink batches, skip scenarios, or prevent the runner from exercising database defects.

The current matrix is concurrent-only. Both concurrency-1 cases are excluded. The user requested a clean restart: all earlier generated reports, archives, journals, SQLite trial state, and logs were deleted; corpus inputs and harness code were kept.

| Scenario | Facts/call | Concurrent logical calls |
| --- | ---: | ---: |
| `parallel-medium` | 100 | 10 |
| `parallel-small` | 10 | 100 |
| `highly-concurrent` | 10 | 1,000 |
| `saturation` | 2 | 10,000 |

Optional environment variables:

- `BENCH_SCENARIOS`: comma-separated scenario names; default all four concurrent scenarios.
- `BENCH_FACTS`: the same fact-stream prefix for every scenario; default 100,000, maximum 2,000,000 (must exist in the corpus). Increasing to 1,000,000 is an explicit later scale-up, not automatic.
- `BENCH_WORKERS`: application services; default 4, maximum 32.
- `BENCH_ATTEMPTS`: maximum attempts per logical call; default 8, maximum 30.
- `BENCH_TIMEOUT_MS`: per-attempt timeout; default 30,000, maximum 120,000.

IDs are unique per run/scenario/batch. Retries retain the exact ID/payload. A concurrency slot includes request and retry/backoff time. Successful responses await the real database commit. Unknown outcomes are retained as unknown to the caller and separately reconciled against quiescent storage; an absent transaction at audit time is not silently reported as a successful load.

Delivery streams the prepared facts with only the outstanding batches in memory. Verification uses a disk-backed SQLite reference/response ledger, then walks the actual fact-store leaves and checks every persisted fact against its transaction's expected fact range. Both pre-/post-restart audits are bounded by page size, not an in-memory copy of the corpus. Latency samples are retained for exact percentiles. The benchmark's local ledger is verification bookkeeping, not part of Poneglyph or an import API. The pre-fix report identifies the unchanged implementation it measured. Subsequent authorized bug fixes are a separately identified revision; transaction/retention/capacity limits remain unchanged; the canonical pooled-ledger/independent-owner architecture is identified by actual bundle inputs.

## Saved evidence

Historical reports moved intact from `bench/write-path/` and retain their original paths/source identities/digests. New manifests hash the root `bun.lock` and workspace manifest. Bun manages the workspace; Node remains required for Miniflare, process-group hosts and the `node:sqlite` ledger. Changing layout does not count as rerunning historical measurements.

After a completed matrix, `results/<run-id>/final.json` retains the source/artifact/dataset identity, final metrics, outcome classifications, and pre-/post-restart audits. During execution, per-case reports and temporary SQLite state are available. After all runtimes and ledgers close, the final aggregate is saved before removing raw trial storage, snapshots, reference ledgers, journals, bundles, and progress samples. Console logs are managed separately. No auth tokens or corpus request bodies are saved in the final report. Incomplete runs must never be treated as successful loads.

Reports distinguish:

- acknowledged committed throughput (never counting retries as new facts);
- all-outcome versus successful-call latency, sample counts, and unavailable tail percentiles;
- busy/error/transport responses, retry exhaustion, and quiescent reconciliation;
- logical outstanding calls versus actual database throughput;
- fact-log membership, active scalar fact/value index checks, terminal coordinator/participant state, and restart persistence;
- local measurements versus **unmeasured** Cloudflare performance.

The disk-backed audit walks router/leaf topology and checks the selected scalar assertion corpus. The separate small-fixture auditor supports only an unsplit root. Retraction semantics use dedicated protocol tests rather than pretending the assertion-only corpus audit models them. Public query and retraction/failure/split semantics are also exercised by the package's existing tests; candidate overlapping-writer invariants require additional tests. The SQL-bind regression now requires successful writes, public query results, and restart persistence for batches of 100, 101, and 1,000 distinct entities.

## Historical findings / deployment gate

See [the result index](results/README.md) for the clean 100k iteration. Earlier measurements have been removed and are not evidence for this restarted comparison.

- Corrected capacity lookup pages use the runtime's 100-binding limit while preserving the 1,000-fact transaction limit.
- Participant prepare replays use durable outcomes before fact-state/capacity checks, including already-committed retractions.
- Retained transaction receipts and payload conflicts are returned even while another writer is active. Required cancellation/recovery still completes before a final outcome.
- SDK retry classification honors explicit boolean server hints; the permanent retained-outcome quota is non-retryable, while temporary busy/read-lease pressure remains retryable.
- Post-commit pruning failures no longer turn a durable published commit into a failed write response; cleanup is deferred without changing fact/index commit requirements.
- Busy responses, retry exhaustion, and transport failures are part of each result. Local generator/runtime limitations must not be mistaken for a cloud DO request-rate ceiling.
- The baseline retains at most 100,000 transaction outcomes for seven days. At 100k facts the largest transaction count is 50,000, so this iteration does **not** exercise that limit. At 1M the two-fact case needs 500,000 transactions and exposes it. Keep that known limitation for scale-up; never raise it, switch graphs, shrink transactions, or route failed facts through a fallback to make a load pass.

No Cloudflare load performance is claimed. Historical candidate experiments are closed; any correctness/performance change to the canonical implementation must be a separately identified revision with new validation. Preserve every original outcome and source/corpus identity. No load is automatically started by the cutover.

## Before cloud execution

The corrected 100k concurrent matrix and its admitted-write/restart audits have completed; remaining protocol/driver/deployment safety gates must pass before cloud execution. Complete outcome reporting and correct durable admitted writes are mandatory; error-free admission is not. Rejected/failed loads remain failed loads, not successful-throughput winners. Missing acknowledged writes, partial commits, unresolved decisions, or index inconsistencies keep the gate closed. Never silently fix or adapt around defects. Then add dedicated database/application deployment configuration and generated binding types; deploy the database first, then applications pointing to it. Authenticate the public application endpoint, keep database/audit access private, confirm the personal account and hard request/storage/cost limits, and run the same manifests. Recheck current provider limits/pricing rather than treating local throughput as a cloud forecast. Retain data/resources until cleanup is explicitly approved.
