# RFD0011: Object ceilings, and a constant-time owner tree

## Status

Measured (2026-10-29). Experiment 3 of [RFD0008](./RFD0008-write-throughput-loop.md). Kept.

## Question

Shards, owner trees and ledgers each saturated around 150–250 calls/s, far below the ~2,000 no-op calls/s the hivemind measured for one Durable Object. Is it the SQLite write each call makes, or our code?

## Probe

The bench site has a `CeilingProbe` object and can aim load generators at it directly (`"probe": {"mode": "noop" | "write1" | "write3", "transport": "fetch" | "rpc"}`), with the same ~200-byte bodies as a write. `"transport": "tree"` instead drives one owner tree alone with the lock+finish pair of a single-owner write.

| Mode | fetch, 128 callers | fetch, 512 | RPC, 128 | RPC, 512 |
|---|---|---|---|---|
| No storage | 1,320 | 1,572* | 2,514 | 1,662* |
| 1 insert | 1,457 | 1,017 | 1,559 | 1,975* |
| 3 statements in a transaction | 705 | 1,328* | 1,337 | 1,692* |

Calls per second; * = some "Durable Object is overloaded" errors at that load. Runs are noisy (±30%).

**One object serves 1,000–2,000 calls/s even when every call writes to SQLite.** Storage confirmation adds latency, not a throughput cap. So our objects' ~200/s comes from our own per-call work.

The owner tree alone did ~270 lock+finish pairs/s (~540 calls/s) at 64–256 callers and was overloaded at 512, at 2.0–2.6 ms CPU per call.

## Finding: the owner tree's cost grew with writes in flight

- `frontier()` found the lowest held revision with `MIN(publication_seq) … WHERE held = 1` over all open slots, without an index. Every finishing writer called it, and so did every waiting writer each time a shared facade publication landed.
- Every lock counted all open slots (`COUNT(*)`) to enforce the in-flight bound.

With hundreds of writes in flight, each call read hundreds of rows, and hundreds of waiters did it again per publication.

## Change

- Partial index `tree_publication_slots_held` on held slots (tree schema v7, migrated in place).
- The in-flight bound uses `highest − visible`, which bounds the open revisions from above (they all lie in between), so no row count.
- The tree remembers its frontier in memory. Every method that opens, finishes or releases a revision, and the split cutover that moves the directory epoch, forgets it.

## Trade-off

The in-flight bound is conservative: done revisions above the visible one count toward it until the visible revision passes them. The bound is 4,096, far above what we reach.

## Result (version `b35a7ad5`)

| Bench | Before | After |
|---|---|---|
| Local tree microbench, 256 callers | 611 / 754 / 786 | 828 / 1,051 / 1,095 pairs/s |
| Production tree alone, 256 callers | 269 pairs/s | **410 pairs/s (+52%)** |
| One owner, full write path | 221 (median) | 185 / 215 / 181 (no change) |

The full one-owner path didn't move, because its slowest step is now the owner's single shard: `_atomic` takes ~730 ms as seen by the ledger and ~290 ms inside the shard, at 2.3 ms CPU per call. A shard's per-write work is real (validation, hashing, about ten indexed inserts across the fact log, active facts, active values and the entity projection), so one shard serves roughly 200–300 writes/s.

## What we learned

- Per-call cost that grows with concurrency is invisible at low load and dominant at high load. Look for scans over in-flight state.
- The shard split trigger (400 calls/s over 5 s) sits above what a shard can serve, so the shard saturates and never splits. That's why splits never fired on traffic.

## Next

Experiment 4: split shards on traffic they can actually reach, and at 1 GB instead of 5 GB.
