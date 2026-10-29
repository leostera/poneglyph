# RFD0010: Wider ledger fan-out

## Status

Measured (2026-10-29). Experiment 2 of [RFD0008](./RFD0008-write-throughput-loop.md). Promising; shipped only behind a graph-ID prefix.

## Proposal

Every write is coordinated by one of a graph's 16 ledgers. A ledger spends about 2.8 ms of CPU per write plus per-event overhead, so 16 ledgers top out near the same ~2,000–2,500 writes/s as the 16 owner trees. Spread transactions over 64 ledgers instead.

The experiment applies only to graphs whose ID starts with `bench-l64-`. They use 64 buckets named `00`…`3f`: token writes pick `sha256(graph, token)` first byte mod 64, plain writes `sha256(txId)` first byte mod 64, and token-minted IDs encode the two-digit bucket (`poneglyph:tx:token:2a:<uuid>`). Every other graph keeps its 16 one-digit buckets, so tokens and IDs written before the change route to the same ledger forever (`tests/ledger-fanout.test.ts` pins that).

## Trade-offs

- **Routing must never change for a live graph.** A token retried after its graph's bucket count changed would reach a different ledger and could apply twice. A real rollout therefore needs the ledger count recorded per graph when the graph is created (or a migration that drains in-flight tokens), not a global constant. The prefix gate is a stand-in for that.
- 64 ledgers retain up to 4× the outcomes (100,000 each), and a graph-wide audit visits 64 objects.

## Result (version `33e0f673`, 2,048 writers, interleaved runs)

| Graph | Runs (w/s) | Median | p50 latency |
|---|---|---|---|
| 16 ledgers | 1,658 / 1,246 / 2,084 | 1,658 | 0.9–1.6 s |
| 64 ledgers | 2,290 / 3,144 / 2,328 | **2,328 (+40%)** | 0.3–0.5 s |

With 64 ledgers the slow step moves to the shards: `_atomic` rose from ~100 ms to 190–380 ms as seen by the ledger, one run hit 368 "Durable Object is overloaded. Requests queued for too long" and 91 finish timeouts, and p99 grew to 3–8 s. Each owner tree still has one shard (none split: ~145 calls/s each is under the 400 calls/s trigger).

## What we learned

- The ledgers were a real cap: with 4× the ledgers p50 latency dropped by half to two-thirds and throughput rose 40%.
- **Shards, trees and ledgers each saturate around 150–250 calls/s**, far below the ~2,000 no-op calls/s one Durable Object handles (hivemind). Their JavaScript CPU (1.3–2.8 ms per call) doesn't explain that alone. The shared factor is that every call writes to SQLite and its reply waits for that write to be confirmed. Experiment 3 measures what one object can do with one write per call.
- The shard split trigger (400 calls/s) is above what a shard can actually serve, so it never fires before the shard is overloaded.

## Next

- Experiment 3: measure one object's ceiling with 0, 1 and 3 SQLite writes per call.
- If writes per call set the ceiling: batch writes per call (fewer, larger calls), and lower the split trigger to what a shard can really serve.
- Record the ledger count per graph before shipping wider fan-out to real graphs.
