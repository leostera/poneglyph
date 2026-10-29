# RFD0009: Owner tree CPU diet

## Status

Measured (2026-10-29). Experiment 1 of [RFD0008](./RFD0008-write-throughput-loop.md). Kept.

## Proposal

A single-owner write costs its owner tree about 5 ms of single-threaded time, which caps one owner at about 150–200 writes/s. Remove work the tree repeats on every call without changing what it guarantees:

1. **Confirm the object's identity once.** Every call ran two SQLite transactions to check (and `INSERT OR IGNORE`) the graph and prefix the object serves. The tree now remembers the confirmed identity in memory; a call for a different graph or prefix still fails with 409.
2. **Don't re-validate a reservation made in the same transaction.** The fused lock+gate call reserved, then re-read the row, the slot, the state and every lock it had just written. It now opens the publication slot directly when the reservation is new; a replayed reservation still goes through the full check.
3. **One statement where there were N.** The entity-lock check is one `IN (…)` query. Publishing releases the locks with `DELETE … RETURNING` and compares the count, instead of a lookup per entity plus a `COUNT(*)` before deleting.
4. **Sweep expired outcomes every 64th reservation,** not on every call. The allocation check still evicts when the owner is full, and an expired predecessor of the same transaction ID is still forgotten at once (identity reuse depends on it).
5. **Read sized request bodies in one call** (`request.text()` when `content-length` is known and within the limit), instead of a streaming reader loop.

## Trade-offs

- An owner keeps expired terminal outcomes up to 63 reservations longer. They only cost space, and the 100,000-row allocation still bounds it.
- The in-memory identity is per instance; a new instance confirms it again on its first call.

## Local check

`tests/tree-cost-bench.test.ts` (opt-in, `PONEGLYPH_RUN_BENCH=1`) drives one owner tree with 32 concurrent lock+finish pairs.

| Revision | Pairs/s (3 runs) |
|---|---|
| Before | 1,049 / 1,080 / 1,088 |
| After | 1,206 / 1,201 / 1,188 |
| Floor: two trivial tree calls | 2,394 / 2,387 / 2,383 |

Locally about half of a lock+finish pair is now the tree's own work; the other half is fixed per-call cost.

## Result (version `873630ee`)

| Bench | Baseline | Diet (runs) | Median |
|---|---|---|---|
| One owner, 256 writers | 146–194 | 221 / 226 / 178 | **221 w/s (+~35%)** |
| Graph, 1,024 writers | 1,937 | 2,055 / 2,457 / 1,222 | **2,055 w/s (same, noisy)** |
| Graph, 2,048 writers | — | 1,983, p90 2.9 s | saturated |

Owner-tree CPU per call at the graph bench barely moved (lock 1.3 → 1.5 ms, finish 1.5 → 1.6 ms, within sampling noise), but per-owner throughput rose. The removed work was mostly SQLite and runtime work that reported CPU does not show well.

A rare failure showed up once: 25 of 61,648 writes answered 503 after about 10 s, the `_tree-finish` wait for an earlier revision (`FINISH_WAIT_MS`). It did not recur in two more runs. The writes were committed; a client retrying with its token gets the receipt. It needs a look: some revision stayed open for 10 s.

## What we learned

- Graph throughput is noisy run to run (1.2k–2.5k w/s with identical code). Take the median of three runs.
- **The graph saturates around 2,000–2,400 w/s:** doubling writers to 2,048 kept throughput and tripled p90.
- **The 16 ledgers are a second cap of the same size as the 16 trees.** A ledger spends about 2.8 ms of CPU per write (plus per-event overhead), so 16 ledgers top out near 16 × 250 w/s. Raising only the tree ceiling would hit the ledgers next.
- Fixed per-call cost (an event, request parsing, JSON, the response) is now as large as the tree's own work, so fewer calls per write (batching, or fusing calls) is the bigger lever.

## Next

- Experiment 2: more ledgers per graph (16 → 64). A constant change for new transactions; existing transaction IDs keep their encoded bucket.
- Then: batch or fuse owner-tree calls, and more owner trees for new graphs.
- Look into the 10 s finish wait.
