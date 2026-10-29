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

## Found along the way

- The packaged-path test compared batch 0's replay with `outcomes[0]`, but the driver records outcomes in completion order. It failed whenever another batch finished first. Fixed to look up batch 0's own outcome. This was a test bug, not a double apply.
- `packages/poneglyph-worker/test/rpc.test.ts` failed once under full-suite load and passed on its own and in the next full run. Flaky; not investigated yet.

## Next

- One owner and the whole graph at 1,024–2,048 writers for 60 s: does throughput keep growing as shards split?
- If the owner pause still hurts: fence only the splitting shard's range, not the whole owner, or copy before fencing and catch up the difference (the snapshot-style split).
