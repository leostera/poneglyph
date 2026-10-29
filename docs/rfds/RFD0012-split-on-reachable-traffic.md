# RFD0012: Split shards on traffic they can reach

## Status

In progress (2026-10-29). Experiment 4 of [RFD0008](./RFD0008-write-throughput-loop.md). Splits now fire under load and take 3–5 s; the throughput gain at high concurrency is not measured yet.

## Proposal

[RFD0011](./RFD0011-object-ceilings-and-constant-time-owner.md) showed one shard serves roughly 200–300 writes/s. The split trigger of 400 calls/s over 5 s sat above that, so a hot shard saturated and never split.

1. **Trigger at 100 calls/s over 5 s**, about half of what a shard serves, so it splits before it saturates. The size trigger drops from 5 GB to 1 GB, so no split has to copy more than ~1 GB.
2. **Copy faster.** A split copied 128 rows per page, one page at a time, over 4 tables × 2 children, with an export call and an import call per page. Pages now hold up to 2,000 rows (still capped at 1.5 MB), the 8 table/child streams run at once, and the 16 verification counts run at once. A recovery test that interrupts the copy after an exact page count still copies one stream at a time, so its count stays exact.
3. **Log every split** from the owner tree (`poneglyph.tree.split` with stage `started` / `drained` / `copied` / `finished` / `failed`, and a `split-drain-timeout` event listing what was still in flight).

## Trade-offs

- Lower triggers mean more shards: a graph under steady load of ~100 writes/s per shard keeps splitting until each shard is under the trigger, up to `maxDepth` (2^12 shards per owner). More shards make cross-shard queries fan out wider.
- A split still fences the whole owner (1/16 of the graph) while it drains and copies. Faster copies shorten the pause; they don't remove it.
- Eight parallel copy streams put more load on the source shard during the split.

## Result so far (one owner, 256 writers, 60 s)

| Version | Splits | Copy time | Pause per split | Writes/s over 60 s |
|---|---|---|---|---|
| Trigger 100/s, old copy (`9cc92bdf`) | 3 (0101 → 01010 → 01011) | 9–17 s | 10–18 s | 82 |
| Trigger 100/s, fast copy (`f4340e20`) | 3 | 2–3 s | 3–5 s | 194 |

With the fast copy, the owner reached four shards by 31 s and then held a steady ~256 writes/s per second. That's exactly 256 writers ÷ ~1 s latency, so this bench is now bound by its writer count, not by the owner. The next run uses 1,024 writers.

## High concurrency (1,024–2,048 writers, 60 s)

| Run | Writes/s | p50 | Errors |
|---|---|---|---|
| One owner, 1,024 writers, splits on | 108 → 17 → 48 | 8.5–14.5 s | up to 4,755 "overloaded" + 3,072 finish timeouts |
| One owner, 1,024 writers, splits off | 114 | 9.7 s | none |
| Graph, 2,048 writers, splits on | 1,176 / 1,238 / 1,120 | ~1.5 s | a few hundred overloaded at worst |
| Graph, 2,048 writers, splits off | 1,283 / 898 | 1.3–2.2 s | none |

Two problems showed up:

1. **Fenced writers retried in a storm.** A fenced lock answered 423 at once, and the ledger forgot its directory, waited 100–300 ms and called `_tree-directory` and `_tree-lock` again. With 1,024 writers that was several thousand calls/s against the owner being split, which overloaded it while it was trying to copy. Fixed in `1133320`: the tree holds a lock request until the split ends (up to 10 s, `FENCE_HOLD_MS`), and the ledger keeps its cached directory and backs off 0.5–1.5 s if a hold runs out. `tests/fence-hold.test.ts` covers it.
2. **One owner under 4× its capacity collapses, with or without splits.** Writes queue at the shard until the runtime drops them ("Requests queued for too long"). Because a revision only becomes visible after every earlier one, one slow write holds every later finish on that owner (head-of-line blocking), up to the 10 s finish timeout. Nothing limits how many writes an owner admits at once.

### Environment drift: A/B against the E1 commit

At 16:00 UTC the graph bench gave ~1,100–1,400 writes/s where it gave ~2,000 at 06:00 with the same code. Interleaved deploys of the E1 commit (`9a80419`) and HEAD (`1133320`), 2,048 writers, 45 s:

| Round | E1 | HEAD |
|---|---|---|
| 1 | 1,381 | 1,213 |
| 2 | 1,193 | 1,386 |

No difference: the platform was slower, not the code. From here on, every comparison is an interleaved A/B in the same session ([RFD0008](./RFD0008-write-throughput-loop.md)).

In both versions `_tree-finish` is ~0.8–1.3 s of the ~1.5 s write: mostly waiting for earlier revisions on the same owner, then for the shared facade publication.

## Found along the way

- The packaged-path test compared batch 0's replay with `outcomes[0]`, but the driver records outcomes in completion order. It failed whenever another batch finished first. Fixed to look up batch 0's own outcome. This was a test bug, not a double apply.
- `packages/poneglyph-worker/test/rpc.test.ts` failed once under full-suite load and passed on its own and in the next full run. Flaky; not investigated yet.

## Outcome

Kept: splits fire on traffic and take 3–5 s, and fenced writers wait instead of storming. Not shown: a throughput gain at high concurrency, because head-of-line visibility and missing admission control dominate there.

## Next

- **Admission control per owner:** cap the writes an owner admits at once (queue lock requests beyond the cap in the tree, FIFO), so a shard is never fed more than it can serve and head-of-line waits stay short. Throughput should then hold at capacity under overload instead of collapsing.
- **Head-of-line visibility** is inherent to one contiguous sequence per owner. Removing it is the timestamp-ordered (CockroachDB-style) redesign.
