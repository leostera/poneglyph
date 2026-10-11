# RFD0005: Repeatable Write-Path Experiment

## Status

Draft proposal (2026-10-11). Defines an experiment, not benchmark results or an implemented storage redesign. The benchmark application, local harness, and parallel-store candidate described below do not yet exist. This RFD does not authorize deployment or account changes by itself.

## Summary

Build `bench/write-path/` as a repeatable application-level benchmark of Poneglyph's ordinary `stateFacts` API. A local driver converts the already-downloaded One Piece corpus into regular facts and sends bounded HTTP requests to one or more application Workers. Those Workers consume the packaged Poneglyph client and await writes to one deployed database containing one graph. Actual fact, index, transaction, and recovery state must be persisted; acknowledgements of queued work are not successful commits. First measure the implementation currently on disk, then the proposed hash-routed, independently sharded fact/index store trees with distributed transaction coordination. Keep the benchmark, dataset, transport, and common workload parameters fixed between versions. Every version and planned scenario must pass end-to-end correctness tests in Miniflare before deployment. Only Cloudflare runs are evidence of cloud performance.

## Context

The current TypeScript implementation has expandable 256-bit entity-prefix routing, local fact/index projections, and one `GraphCoordinatorDO` per graph. The coordinator serializes graph write decisions and publishes a global visibility sequence; storage sharding does not distribute this authority. [RFD0004](./RFD0004-expandable-cloudflare-sharding.md) describes that implementation and its bounded evidence.

The existing [One Piece harness](../../examples/onepiece-load.ts) starts a local Worker and writes serialized batches of up to 500 facts directly to its HTTP endpoint. The existing [local benchmark](../../poneglyph/tests/throughput-bench.test.ts) also bypasses the public client and caps concurrency at 16. Neither is the desired application-client-database experiment at 1,000 concurrent calls.

The working-tree [client](../../poneglyph/src/client.ts) currently offers `state`, `transact`, and `query`, not `stateFacts`. It accepts injected `fetch`, caller-provided transaction IDs, and does not retry automatically. Its receipt includes `commitSeq`. The baseline must include the reviewed working-tree code, not silently substitute the last committed revision; capture the source actually built.

The corpus is already downloaded locally. It is input to an application workload, not a reason to add an import subsystem to the database. Changing batch size and concurrency can change write amplification and contention. More application Workers may remove an application bottleneck, but cannot by themselves remove the baseline's single graph coordinator.

## Goals

- Measure the real write path through the packaged client, including actual persistent facts and required index updates.
- Compare transaction batching against concurrent smaller transactions, including 10 facts per call and 1,000 in-flight calls, and 2 facts per call and 10,000 in-flight calls.
- Support multiple application Workers feeding the same database and same graph.
- Establish a reproducible current-code baseline before changing storage architecture.
- Compare that baseline with independently routed fact/index store subtrees and distributed transaction coordination.
- Verify write correctness locally before spending account resources on cloud performance measurements.
- Expose rejected requests, retries, ambiguous outcomes, contention, routing, and storage/index amplification rather than hide them behind a throughput average.

## Non-goals

- An import API, special import completion token, source connector, queue, workflow, or background ingestion service.
- Resolving `query(txId, query)`, latest transaction, historical read, cursor, or graph-wide snapshot semantics. Queries here are post-write verification tools, not a query-throughput experiment.
- Public npm publication, changes to unrelated resources, or modifications to FokosDB.
- A physical 50 GB/1 TB load, synthetic capacity accounting presented as writes, an SLA, or a claimed universal database throughput.
- Weakening append-only semantics or removing required indices to obtain a favorable candidate result.

## Design

### Application flow and boundaries

```text
local corpus -> local HTTP driver -> application Worker(s)
                                      -> packaged Poneglyph client
                                      -> one Poneglyph database Worker
                                      -> SQLite-backed Durable Objects
```

The application exposes an authenticated, bounded `POST /facts` accepting `{txId, facts}`. It validates the envelope, calls the package API, awaits the database result, and returns `{txId}` only on success. Application errors must preserve useful failure classifications without leaking secrets. Curl can exercise the endpoint; the load driver uses that same endpoint and contract. There is no success response followed by a `waitUntil` commit.

The proposed write API is:

```typescript
const db = await createDatabase(poneglyphConfig);
const txId = await db.stateFacts(facts, { txId: requestTxId });
```

`createDatabase` may be awaited even if local construction is synchronous. `stateFacts` is the public write operation to add before the benchmark; the options retain caller-supplied identity for retries. The baseline may make this small client-surface change but must not redesign storage, change limits, or add a faster internal write path. Document/package-test that change. Keep baseline-only receipt/sequence details out of the application contract. One configured graph is used throughout a deployment; do not distribute load across graph IDs to evade the coordinator.

The package is built and consumed through its exported interface as a pinned artifact, not via source imports into storage internals. Use a private local package artifact; a public npm release is unnecessary. Select HTTP over a service binding through the client's injectable `fetch` if supported and validated; otherwise authenticated HTTPS. Freeze the chosen transport across database comparisons and record it. The application never receives DO bindings or bypasses the database's transaction path.

Suggested layout (proposed files):

```text
bench/write-path/
  worker/        # benchmark application and deployment configuration
  corpus.ts      # local-only deterministic fact extraction
  scenarios.ts   # workload and scheduling definitions
  run.ts         # bounded HTTP driver, receipts, verification, reports
  tests/         # multi-Worker Miniflare and failure tests
  results/       # small manifests/summaries, not corpus or secrets
  README.md      # reproducible commands and account/resource procedure
```

### Version A: current code on disk

Capture a buildable snapshot of the current implementation, including reviewed uncommitted client changes. Record the Git base, source-tree digest, and an archival patch or commit sufficient to reproduce the built source. Preserve unrelated working-tree changes. Freeze this baseline before developing Version B.

Run the current coordinator, participant, split, and index behavior without tuning away its bottlenecks. Use separate benchmark deployment configuration; do not repurpose the previous scale-out/TODO validation configuration or its resources. Store baseline reports even if concurrency mostly produces busy responses.

### Version B: parallel store trees

The experimental candidate has separate fact and required index store trees, with durable leaf/router ownership over versioned 256-bit hash keys. Fact ownership uses canonical entity identity; an entity's canonical facts remain colocated. EA/AV and other supported index entries are replayable derived state, not a mutable replacement for the fact log. Each index has an explicitly defined canonical routing tuple; routing AV solely by attribute is not assumed. For example, routing by `(attribute, value)` permits different values to reach different leaves, but a hot exact tuple may still contend.

Plan a transaction's actual fact and index participant owners, stage all mutations, persist one commit/abort decision, and apply/recover idempotently. Route transaction control across a coordinator pool by transaction identity, or an equivalently demonstrated distributed mechanism. No graph-wide writer reservation, root router, or global transaction metadata update may remain an unnoticed per-write serialization point. An opaque transaction ID does not require a global incremental allocator.

The hypothesis is that transactions with disjoint **actual participant owner sets** can progress concurrently. Different entity URIs alone are insufficient: their index writes may share an owner. Contention at shared owners remains allowed and must be measured. Do not promise unlimited parallelism from a hash function.

Before implementing Version B, specify its exact index set and key encodings, participant conflict rules, transaction decision/recovery records, identity retention, and split fencing in a companion architecture RFD or amendment. Account for every required index participant in limits. Preserve append-only facts, payload-bound idempotency, durable outcomes, and atomic transaction visibility; this experiment does not waive those invariants. The old global `visible_seq` mechanism cannot simply be deleted and replaced with independently visible participant writes. The write-only benchmark does not settle a replacement public query contract or prove multi-shard reader atomicity.

Version B is deployed in new versioned namespaces. No in-place reinterpretation of Version A's storage and no baseline-data migration are required for this experiment.

### Workload and dataset

Extract one deterministic ordered fact stream from the entire locally downloaded One Piece XML. Record archive/XML checksum and bytes, extraction version, page/entity/fact counts, canonical fact-stream digest, value/field distribution, and duplicates. Reuse extraction logic where suitable, but audit it first: the existing extractor caps categories/links, uses potentially colliding title slugs, and adds hand-authored domain facts. State these policies explicitly, prevent unintended entity collisions, and distinguish corpus-derived facts from any supplemental correctness fixtures. Processing every page does not imply preserving all wiki text or every link.

Corpus decoding is local workload preparation, not a database feature. Generate a bounded on-disk stream/manifest before timing so parser/CPU stalls do not masquerade as database limits. The canonical payloads include real values; no synthetic payload-size substitutions. Keep extraction fixed between versions and scenarios. Do not commit the downloaded corpus.

| Scenario | Target facts/call | Maximum concurrent logical calls | Facts in a full initial wave |
| --- | ---: | ---: | ---: |
| Serial small | 100 | 1 | 100 |
| One large transaction | 1,000 | 1 | 1,000 |
| Parallel medium | 100 | 10 | 1,000 |
| Parallel small | 10 | 100 | 1,000 |
| Highly concurrent small | 10 | 1,000 | 10,000 |
| Single-authority saturation probe | 2 | 10,000 | 20,000 |

The 10,000-call scenario is intended to expose the single-DO coordination bottleneck using very small transactions. Cloudflare documents approximately 1,000 requests/second per object as a soft limit, with achievable throughput depending on work per request [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/); neither 2,000 RPS nor any other fixed rate is a Poneglyph benchmark or guaranteed hard ceiling. In-flight calls are not requests/second. Measure the actual arrival/attempt rate, completion rate, busy/overload responses, and retry amplification. Ramp to 10,000 outstanding logical calls within explicit local/cloud resource and request caps; do not assume the driver or application Workers can sustain that target. Additional application Workers/drivers may supply load but cannot remove a shared database coordinator bottleneck.

A logical call occupies one slot from its initial attempt through bounded retry or final outcome. Refill a slot when it finishes until the corpus is exhausted; this is sustained closed-loop load, not only one burst. Record ramp-up, achieved concurrency, tail/drain time, and backoff occupancy. Use identical fact order and batching policy; the final batch may be smaller and is reported. Assertion/retraction ordering tests are separate from the assertion-oriented corpus workload.

The current limits are [1,000 facts, 1,000,000 canonical bytes, and 32 participant leaves per transaction](../../poneglyph/src/storage/constants.ts). Preflight and record actual serialized request size and effective database limits. A configured 1,000-fact batch may exceed byte or participant limits; report the unsupported/rejected scenario without silently shrinking it. If a separately labeled byte-bounded variant is needed, preserve its realized batch distribution and compare that same variant across versions. Never compare only the convenient accepted subset as if the whole corpus succeeded.

Application Worker count is an independent parameter: start with 1 and compare 4 workers, expanding only when measurements show an application/driver bottleneck. All point to the same database. Cloud routing need not yield distinct physical isolates; multiple names are not proof of added execution capacity. Fix Worker count in paired comparisons and record observed distribution.

### Local correctness gate: Miniflare first

For each version, run the actual application/package/database path under Miniflare with SQLite DO persistence and local service bindings or the selected equivalent HTTP transport. Run every planned scenario, including the 1,000- and 10,000-concurrent-call cases and multiple application Workers, over the corpus. Separately use small controlled fixtures for deterministic failures. A complete outcome report is required; error-free admission at every concurrency is not required, but every admitted outcome must be correct and unmet workload targets must be recorded.

Required checks:

- Awaited success corresponds to durable completed writes to every required fact/index participant, not acceptance into a buffer.
- Expected facts are present exactly once per successful transaction despite same-ID/payload retries; same ID with a changed payload conflicts within the documented retention window.
- A bounded quiescent audit reconciles expected facts, transaction membership, and every required index entry, detects missing/extra rows, and verifies reverse/index lookup paths. Active tuple counts are not a substitute for fact-log counts when assertions repeat.
- Restart the local database runtime using the same persistence and repeat verification. An application Worker restart must not require a remembered transaction list to recover database state.
- Reject invalid batches/retractions and over-limit transactions without partial effects. Include retraction/index removal and batch-order tests.
- Interrupt before prepare completion, after the durable decision, and between participant applies; lose responses; retry and recover. No irreversible commit is subsequently aborted; cancelled transactions have no active/index effects. Transport timeout alone is not evidence of abort.
- Exercise stale routes and split/cutover/recovery against actual staged transactions for the candidate. Existing single-writer/global-split tests alone do not cover overlapping candidate writers.
- Prove candidate disjoint-owner progress with controlled participant barriers: hold one transaction at a participant and demonstrate another disjoint transaction can finish. Test shared-owner contention separately. Do not infer parallelism from merely launching promises or from local timing.

Verification can use restricted read-only audit hooks when public query limits prevent complete enumeration. They must not bypass writes, repair data, enter the timed path, or be publicly exposed in cloud deployments. Run bounded public query checks too. Fault injection is local, not an unbounded destructive cloud exercise. Miniflare measures correctness/reproducibility only, never Cloudflare capacity.

### Cloud performance protocol: only after the local gate

1. Verify the personal account, effective limits, available usage visibility, resource names, and explicit run caps (facts, requests including retries, duration, concurrency, and estimated cost). If cost/usage cannot be observed, state the gap and obtain an agreed bounded budget before the full run. Do not claim included usage or zero incremental cost.
2. Build/typecheck/package-test and dry-run the dedicated database deployment. Deploy it first with fresh storage, then deploy authenticated application Worker(s) with the pinned client and database connection. Smoke-test the same path before corpus traffic.
3. Run each admitted corpus scenario in fresh storage for each trial. Prefer at least three paired trials per comparable scenario, with recorded ordering to reduce time-of-day confounding. A trial must be large enough to exercise sustained concurrency; label short runs as exploratory, not steady-state/tail evidence.
4. Separate untimed application/transport warm-up from the measured fresh-database load. Warming a different namespace does not warm the measured database's DOs; report those first-use costs instead of claiming a fully warm run. Any additional warmed/preloaded trial is a separate scenario with its initial data and topology recorded. Record initial/final topology, placement hints, splitting, routing cache state, capacity configuration, and DO counts.
5. Record both ordinary fresh-tree/corpus behavior and separately labeled controlled-topology contention experiments. Version A may remain on one unsplit leaf at this corpus size. Controlled pre-splitting is untimed setup, not a faster write path; freeze and report it. For candidate disjoint-owner tests, verify leaf owner sets across facts **and all indices** rather than claim disjointness from entity names.
6. Send real fact batches through the application, await successful completion, and persist actual fact/index/decision rows. No no-op database mode, mocked participants, delayed indexing, or synthetic byte accounting.
7. After traffic drains, reconcile ambiguous outcomes, run quiescent persistence/index audits and bounded public queries, and mark trials with missing/partial/corrupt data invalid. Do not publish favorable throughput from invalid trials.
8. Retain deployment/data until cleanup is explicitly approved. List all created resources and their ownership; any teardown removes only experiment resources and verifies completion.

Use bounded connections and timeouts in the driver; allow multiple driver processes if one cannot sustain the target, with coordinated unique identities and a shared timing/report manifest. Inspect CPU, payload-read stalls, connection limits, application distribution, and scheduling lag. Do not label generator saturation as database saturation.

### Outcomes, retry, and measurement contract

Use unique transaction IDs derived from run/scenario/ordinal, not graph-global order. Persist a local request/receipt journal to resume delivery and audit outcomes. This is test-driver state, not a database import pipeline. Retry the exact ID and payload with bounded backoff/jitter on classified retryable failures; freeze retry policy across versions. The SDK must not acquire invisible automatic retries. Report non-retryable rejection, retry exhaustion, and ambiguous transport failures separately. Reconciliation uses same-ID replay or a supported status operation; any unresolved transaction stays unknown, not silently failed or counted successful.

Timing begins when the driver first submits a logical call and ends on its final acknowledgement/outcome. End-to-end latency includes retries/backoff; separately record each attempt latency and application time awaiting `stateFacts`. Do not subtract network time and present the remainder as measured database execution time. Telemetry may separately measure internal stages.

Report:

- Unique acknowledged committed facts/s and transactions/s over the full timed workload, including ramp/drain, plus interval throughput. Do not count retry payloads as new facts. Separately report commits discovered only by later reconciliation and time-to-reconciliation.
- Logical-call and attempt latency distributions, success/failure counts, unknown outcomes, retry/backoff counts, completed facts, actual batch sizes/bytes, and achieved outstanding-call distribution.
- Raw sample count and percentile method. Publish p50/p95/p99 only with adequate samples (target at least 10,000 completed calls for p99); otherwise label tails insufficient. Across trials show each result and spread, not only the best.
- Per-stage timings when available: client/database request, route resolution, prepare, decision, apply/completion; participant fan-out and coordinator/leaf contention, split pauses, routing hops/cache hits, SQL row writes, reported physical storage, and amplification. Missing provider metrics are unknown, not zero.
- Exact source/artifact digests for database, client, and application; harness revision, runtime/tool versions, limits, retry policy, transport, Worker count, dataset manifest, topology, run timing, account plan, and verified local gate identifier.

Keep traces/logs structured and sampled consistently. Enable logs and traces for the dedicated deployments; never log corpus bodies, secrets, or auth headers. Retry storms and excessive instrumentation can distort results and incur costs. Preserve small reports/manifests in `results/`; keep bulky raw samples as referenced artifacts with checksums. No benchmark result exists until implementation and execution complete.

## Acceptance criteria and interpretation

The experiment is usable when its application consumes the packaged `stateFacts` API, its scenarios replay identical inputs, its local gates audit durable facts/indices and failure recovery, and its cloud runs save reproducible outcome/latency/throughput reports. A baseline completing with contention or unsupported scenarios is still informative; it must not be silently optimized before recording.

Version B supports the architectural hypothesis only if disjoint-owner progress is demonstrated locally, every required index still participates, correctness gates pass, and paired cloud runs show an improvement under the relevant scenario without hiding errors, retry time, storage amplification, or changed limits. No improvement is a valid result. The real corpus measures practical shared-index contention; controlled disjoint/shared-owner fixtures explain the mechanism and are never mislabeled corpus results.

This comparison intentionally includes the cost of separately stored indices in Version B. It is a whole-design comparison, not an isolated claim that coordinator sharding alone caused a speedup. If attribution is needed, add a separately labeled intermediate version without replacing the required baseline and candidate.

## Alternatives

| Alternative | Reason not selected |
| --- | --- |
| Extend only the current direct-endpoint script | Does not validate the deployed application's packaged-client path or 1,000 concurrent calls. Reuse extraction, not its bypass. |
| Direct DO writes or queued acknowledgements | Removes transaction/index completion work and measures a different database contract. |
| Only local benchmarks | Useful for debugging and correctness; not evidence of managed Cloudflare performance. |
| Deploy first and validate afterward | Risks paying for fast but incorrect writes; violates the mandatory local gate. |
| Many graphs/databases to increase throughput | Avoids the per-graph bottleneck instead of measuring parallelism within one graph. |
| Do nothing / only tune the driver | Leaves no reproducible application-level baseline and cannot establish the proposed architecture's benefit. |

## Consequences and open questions

- The benchmark creates real billed compute, SQL/index writes, and retained storage. Increasing concurrency can increase retry traffic without increasing useful throughput.
- Large transactions can span more owners, amplify failure cost, or exceed limits; smaller transactions add coordination/HTTP overhead. Measuring the trade-off is the point.
- Corpus loading grows the database throughout a run. Fresh/controlled topology and interval measurements are needed to distinguish batching, contention, and split effects.
- Before implementation: accept the experiment contract and public `stateFacts` naming. Before Version B: specify the participant/index/conflict/recovery/split protocol and explain how atomic visibility is preserved without claiming a completed snapshot redesign.
- Implementation-time: verify the pinned tooling's multi-Worker Miniflare support and service-binding client adapter; establish collision-free fact extraction and bounded full-data audits.
- Before cloud execution: agree the target account/resources and hard cost/work limits, including a stop policy for retries, storage growth, and invalid data.
- Out of scope: choosing a latest read token, total transaction order, or public stable-graph-snapshot API.

## References

- [RFD0003: Cloudflare-native graph database](./RFD0003-cloudflare-native-graph-database.md)
- [RFD0004: Expandable, capacity-bounded sharding](./RFD0004-expandable-cloudflare-sharding.md)
- [Current client](../../poneglyph/src/client.ts), [package](../../poneglyph/package.json), and [limits](../../poneglyph/src/storage/constants.ts)
- [Existing corpus workload](../../examples/onepiece-load.ts), [local benchmark](../../poneglyph/tests/throughput-bench.test.ts), and [bounded operational evidence](../../poneglyph/OPERATIONS.md)
- [Miniflare](https://developers.cloudflare.com/workers/testing/miniflare/) and [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [SQLite-backed DO storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [limits](https://developers.cloudflare.com/durable-objects/platform/limits/), and [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Worker service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) and [observability](https://developers.cloudflare.com/workers/observability/)
