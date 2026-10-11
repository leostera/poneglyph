# Write-path experiment

Implements the **Version A / current-code local baseline** from [RFD0005](../../docs/rfds/RFD0005-write-path-experiment.md). Cloud execution and Version B are not implemented or measured yet. The baseline has a reproduced SQL-bind defect. The cloud gate is **closed pending the full-input local matrix and correctness/resource gates**; database errors are recorded, not repaired by the benchmark.

## What runs

```text
local HTTP driver -> gateway -> 1..32 application Workers
                                   -> @leostera/poneglyph.stateFacts
                                   -> database Worker (service binding)
                                   -> real Miniflare SQLite Durable Objects
```

All applications use one graph in one database per trial. The gateway selects application services locally; it is not a new database coordinator. Production coordinator/shard write methods are inherited unchanged. The benchmark subclasses add read-only audit methods, reachable only by a token-protected local entrypoint. They must not be exposed on a public cloud route.

The client is a pinned `file:` package dependency containing the built package exports, not a direct import of database internals. `stateFacts` is an added client method delegating to the existing transaction protocol. No faster baseline storage path was introduced. The existing `state` method is retained.

## Reproduce locally

From the repository root:

```sh
cd poneglyph
pnpm run build:package
cd ../bench/write-path
pnpm install
pnpm run typecheck
pnpm test
pnpm run prepare:corpus
pnpm run preflight
BENCH_FACTS=100000 BENCH_WORKERS=4 pnpm run run:local
```

`prepare:corpus` uses the cached `tests/fixtures/cache/onepiece-pages-current.xml`, or accepts an XML path as its first argument. It prepares ordinary facts locally; there is no database import API. Exact percent-encoded titles prevent the old extractor's lossy-slug collisions. The manifest records all pages processed, the 8-category/16-link extraction caps, and omission of full wiki text. No hand-authored domain facts are mixed into the corpus.

The iteration comparison attempts **the same first 100,000 corpus facts in every scenario**. Only after a candidate demonstrates repeatably better throughput and correct durable writes/recovery should the comparison scale back to 1,000,000. The complete prepared corpus contains **1,530,195 facts from 296,624 pages**. `preflight` is informational; it does not write data, shrink batches, skip scenarios, or prevent the runner from exercising database defects.

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

Delivery streams the prepared facts with only the outstanding batches in memory. Verification uses a disk-backed SQLite reference/response ledger, then walks the actual fact-store leaves and checks every persisted fact against its transaction's expected fact range. Both pre-/post-restart audits are bounded by page size, not an in-memory copy of the corpus. Latency samples are retained for exact percentiles. The benchmark's local ledger is verification bookkeeping, not part of Poneglyph or an import API. The baseline storage implementation, SQL-bind defect, and retention limits are **not** modified to improve results.

## Saved evidence

Each `results/<run-id>/` contains a source/artifact/dataset manifest, one JSON report per scenario, and a summary. Current runner reports also retain compressed outcome journals and Worker bundles. Bulky SQLite persistence and original journals stay in ignored `.data/runs/<run-id>/` on this machine. No auth tokens or corpus request bodies are saved in reports. Incomplete runs must be labeled incomplete, never treated as successful loads. The earlier artifacts were explicitly deleted at the user's request; newly generated results are saved normally.

Reports distinguish:

- acknowledged committed throughput (never counting retries as new facts);
- all-outcome versus successful-call latency, sample counts, and unavailable tail percentiles;
- busy/error/transport responses, retry exhaustion, and quiescent reconciliation;
- logical outstanding calls versus actual database throughput;
- fact-log membership, active scalar fact/value index checks, terminal coordinator/participant state, and restart persistence;
- local measurements versus **unmeasured** Cloudflare performance.

The disk-backed audit walks router/leaf topology and checks the selected scalar assertion corpus. The separate small-fixture auditor supports only an unsplit root. Retraction semantics use dedicated protocol tests rather than pretending the assertion-only corpus audit models them. Public query and retraction/failure/split semantics are also exercised by the package's existing tests; candidate overlapping-writer invariants require additional tests. The focused SQL-bind characterization test intentionally expects the baseline defect; its passing does not mean the advertised write contract passes.

## Current findings / deployment gate

See [the result index](results/README.md) for the clean 100k iteration. Earlier measurements have been removed and are not evidence for this restarted comparison.

- A batch with **101 distinct entities** reproduces `503: too many SQL variables` in capacity preflight. The storage implementation chunks an entity `IN (...)` lookup at 500, above the runtime's observed 100-bind limit. A valid 1,000-fact batch can trigger it. No partial fact/index writes were observed in the reproduction. The storage defect has **not** been patched into the baseline.
- Busy responses, retry exhaustion, and transport failures are part of each result. Local generator/runtime limitations must not be mistaken for a cloud DO request-rate ceiling.
- The baseline retains at most 100,000 transaction outcomes for seven days. At 100k facts the largest transaction count is 50,000, so this iteration does **not** exercise that limit. At 1M the two-fact case needs 500,000 transactions and exposes it. Keep that known limitation for scale-up; never raise it, switch graphs, shrink transactions, or route failed facts through a fallback to make a load pass.

Therefore **no Cloudflare load was deployed**, no cloud performance is claimed, and Version B has not been implemented. Preserve Version A evidence first; any baseline bug fix must be a separately identified revision with new measurements. The architecture amendment required by RFD0005 remains a prerequisite to Version B.

## Before cloud execution

Finish and save the 100k concurrent matrix and pass the local correctness gate before cloud execution. Complete outcome reporting and correct durable admitted writes are mandatory; error-free admission is not. Rejected/failed loads remain failed loads, not successful-throughput winners. Missing acknowledged writes, partial commits, unresolved decisions, or index inconsistencies keep the gate closed. Never silently fix or adapt around defects. Then add dedicated database/application deployment configuration and generated binding types; deploy the database first, then applications pointing to it. Authenticate the public application endpoint, keep database/audit access private, confirm the personal account and hard request/storage/cost limits, and run the same manifests. Recheck current provider limits/pricing rather than treating local throughput as a cloud forecast. Retain data/resources until cleanup is explicitly approved.
