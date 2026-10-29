# RFD0008: Write throughput experiments

## Status

Running (2026-10-29). This RFD is the index and method for a series of small write-throughput experiments. Each experiment gets its own short RFD with a proposal, the trade-offs it accepts, and the measured result. Nothing here changes the public API or the consistency contract in RFD0004/RFD0005 unless an experiment RFD says so.

## Goal

Raise sustained writes per second, per graph and per owner tree, while keeping every receipt "durable and visible to the next query". Lower write latency where it comes along.

## Loop

1. Write a small RFD for one design change: what, why it should help, what it costs.
2. Implement it on `perf/fewer-write-calls`; run the worker tests and the full `bun run test` (conformance included).
3. Deploy to the benchmark target `poneglyph.lostera.me.cloudflare.dev` (Worker `poneglyph-lostera-me-cloudflare-dev`, account `776b37f0f2474156eb01cf93c764b2e9`, work profile).
4. Run the two standard benches on fresh graphs, then pull per-call CPU and wall time from Workers telemetry.
5. Record the result, what we learned and what to try next in that RFD, and add a row below.

## Standard benches

Load comes from `LoadGenerator` Durable Objects on the edge (`POST /_bench/writes`, see `sites/poneglyph.lostera.me.cloudflare.dev`). Each writer sends one single-fact transaction at a time to a random entity, no client-side retries, 30 s per run, a fresh graph per run.

- **Graph:** 32 generators × 32 writers (1,024 concurrent writers) across the whole graph.
- **One owner:** 16 × 16 (256 writers), every entity inside owner tree `0101`. This measures the per-owner ceiling.

Telemetry: invocation logs are sampled (`headSamplingRate` 0.05; 1.0 while diagnosing splits, so split logs aren't sampled away); CPU and wall time per Durable Object call come from `$workers.cpuTimeMs` / `$workers.wallTimeMs`, grouped by entrypoint and path. Reported CPU counts JavaScript time only, so per-call runtime overhead (about 0.4–0.5 ms per event, per the hivemind note on Durable Object call rates) comes on top.

## Baseline (version `4063950c`, commit `ad06780`)

| Bench | Writes/s | p50 | p99 | Errors |
|---|---|---|---|---|
| Graph, 1,024 writers | 1,937 | 471 ms | 2,205 ms | 16 × 423 (same entity) |
| One owner, 256 writers | 146 | 1,668 ms | 3,162 ms | 22 × 423 |
| One owner, 64 writers | 139 | 413 ms | 1,626 ms | 9 × 423 |
| One owner, 1,024 writers | 171 | 6,002 ms | 9,293 ms | 93 × 423 |

Per-call cost at the graph bench (mean CPU / median wall):

| Call | CPU | Wall |
|---|---|---|
| ledger `/_transact` | 2.9 ms | 454 ms (the whole write) |
| tree `/_tree-lock` | 1.3 ms | 11 ms |
| shard `/_atomic` | 1.7 ms | 14 ms |
| tree `/_tree-finish` | 1.5 ms | 188 ms (waits for earlier revisions and the facade) |

At the one-owner bench the tree spends 1.7 ms (lock) + 2.6 ms (finish) of JavaScript per write, plus two events of runtime overhead: about 5 ms of its single thread per write.

## What the baseline says

- **One owner tree caps at about 150–200 writes/s,** because each write costs it about 5 ms of single-threaded time. More writers only add latency. The graph's ceiling is about 16× that, because the 16 owner trees are fixed.
- **The graph bench is latency-bound, not saturated:** each tree runs at about 120 writes/s, well under its cap, and 1,024 writers ÷ 0.47 s ≈ 2,200 writes/s.
- **Latency is hops times confirmations.** Seen from the ledger a tree lock takes 77 ms, but the tree handles it in 11 ms: the rest is the ledger's own storage confirmation (outbound calls wait for it) plus the network. Every hop pays that. `_tree-finish` adds about 190 ms of waiting for earlier revisions and the shared facade publication.
- **Shards never split on load:** a shard behind a capped tree sees at most ~200 calls/s, half of the 400 calls/s trigger.

## Experiments

| RFD | Change | Graph w/s | One owner w/s | Outcome |
|---|---|---|---|---|
| — | Baseline | 1,937 | 146 | — |
| [RFD0009](./RFD0009-owner-tree-cpu-diet.md) | Owner tree CPU diet | 2,055 (median) | 221 (median) | Kept; owner +35% |
| [RFD0010](./RFD0010-wider-ledger-fanout.md) | 64 ledgers (prefix-gated) | 2,328 vs 1,658 (2,048 writers) | — | Promising; needs per-graph ledger count |
| [RFD0011](./RFD0011-object-ceilings-and-constant-time-owner.md) | Probe object ceilings; constant-time owner tree | — | 185 (shard-bound) | Kept; tree alone +52% |
| [RFD0012](./RFD0012-split-on-reachable-traffic.md) | Split at 100 calls/s or 1 GB; fast parallel copy | — | splits in 3–5 s | In progress |

## Ideas not yet tried

- Batch owner-tree calls in the ledger: one tree call carries many writes.
- More owner trees for new graphs (`TREE_DEPTH` 5 or 6: 32 or 64 trees).
- Shards own their writes (per-shard locks and sequences; a single-shard write is one call).
- Timestamp-ordered snapshots instead of per-tree sequences (CockroachDB-style), which removes the fixed tree layer.
- Fewer storage confirmations on the ledger path (write the intent once, not per phase).
