# RFD0007: A write-ahead log in front of the graph

## Status

Exploring (2026-10-29). Nothing here is implemented or measured. This RFD frames the question and proposes the experiments that would answer it; it changes no contract in RFD0004 or RFD0005.

## Question

Can Poneglyph take many more writes per second by putting a write-ahead log (WAL) in front of the entity-sharded storage, and if so, what kind of log?

Three candidate logs:

- **A. One Durable Object per graph** that sequences every transaction.
- **B. A splittable object** keyed by transaction ID, using the `splittable-object` package from r2facts (RFD0009 there), which splits itself by load.
- **C. R2**, as the durable home of log segments.

## Where we are today

A write goes client → ledger bucket (one of 16) → owner trees (reserve) → shard leaves (prepare) → ledger (commit) → shards (apply) → owners (publish) → receipt. The receipt means "durable **and** visible to the next query". Every step is a Durable Object call on the request path.

Two facts frame the design:

- **One Durable Object handles about 800 calls/s** regardless of what a call does (measured in r2facts RFD0008). Throughput is bounded by calls, not bytes: putting 1,000 facts in one call costs about the same as one fact.
- **Poneglyph's storage already splits.** Shard leaves sit under 16 fixed owner roots (`TREE_DEPTH` = 4) and split by key prefix when they pass `SHARD_SPLIT_TRIGGER_BYTES` (5 GB). Routing walks a directory with epochs, and retired epochs answer 410. This is the same shape as a splittable object, except that it is triggered by size rather than load and is written specifically for Poneglyph.

## What a WAL would buy

1. **Fewer calls per fact.** A log can batch many transactions into one apply call per shard (group commit). This is the main throughput lever, since cost is per call.
2. **Coordination off the request path.** The client waits for one durable append instead of a seven-step protocol.
3. **Derived views for free.** Anything that reads the log can maintain a view incrementally: the per-shard field/type summary that `getSchema` needs (instead of scanning every fact), value indexes, and change feeds or subscriptions.
4. **With a sequenced log, possibly no 2PC.** If every shard applies transactions in the same log order, and every check is deterministic, shards don't need to vote. This is the Calvin design (Thomson et al., 2012). It would also give the graph a real global order, which `snapshotSeq` does not provide today.

## What it costs

- **"Acknowledged" splits in two.** Today one receipt means durable and visible. With a WAL, the append is durable first and the apply makes it visible later. Either the client gets two signals (`durable`, then `visible` or `visibleAt(seq)`), or queries wait for, or read, the unapplied tail. Read-your-writes has to be designed rather than inherited.
- **Rejections must move.** Today a shard can refuse a write during prepare (for example, retracting a fact that isn't active). After a durable append there is no one to refuse to. Each check must either run statelessly before the append (shape, limits, URIs), or be deterministic at apply and recorded as a per-transaction outcome the client can read.
- **A log doesn't put data near its readers.** Queries still read entity-sharded state, so the apply side stays, along with its splits, leases and snapshots. The WAL adds a layer; it doesn't replace storage.
- **Recovery and retention:** log truncation, replay after a crash, and how long to keep the tail for retries and request tokens.

## The three logs

### A. One sequencer Durable Object per graph

- **Order:** total and trivial. Sequence numbers are global, which simplifies snapshots.
- **Ceiling:** about 800 calls/s per graph. With batching (Workers or a small front tier coalescing requests into one append), facts/s = calls/s × facts per call, which could still reach tens of thousands of facts/s.
- **Risk:** a single location and a single point of latency for a graph, with a hot spot by construction.
- **Fit:** the simplest experiment, and the cleanest route to Calvin-style deterministic apply.

### B. Splittable log keyed by transaction ID

- **Distribution:** transaction IDs are server-minted UUIDs, so hashing (or reversing) them spreads evenly, and splitting by load follows traffic. It goes from 1 write/s to 10,000 writes/s with a short ramp while nodes split.
- **Order:** none across partitions. To recover a global or per-entity order, partitions must close epochs (for example, every 10 ms, as Calvin's sequencers do) that a merger orders deterministically. Without that, two transactions on the same entity in different partitions have no agreed order, so the apply side still needs today's owner fencing.
- **Fit:** the highest ingest ceiling, and it reuses r2facts' package. But it adds an epoch or merge layer, or keeps 2PC on the apply side.

Note: r2facts' splittable object hands rows from a frozen parent to its children on demand and through a background copy. It doesn't use the Durable Object snapshot/clone API. Cloning would copy all the rows into both children, after which each child deletes its other half.

### C. R2 as the log

- **Fit as the commit point:** poor. A PUT per append adds latency and per-operation cost, and there's no conditional append.
- **Fit as cold storage:** good. A Durable Object buffers the tail, and sealed segments go to R2, as r2facts already does for git data. Replay and new derived views read the segments from R2.

So C is a tier under A or B, not an alternative to them.

## A side question: reuse `splittable-object` for shard leaves?

This is independent of the WAL. Poneglyph's split, route and epoch machinery (`routing.ts`, `migration.ts`, the split parts of `shard.ts`) could be replaced by r2facts' package, with split-by-load added to split-by-size. Things to check first:

- Poneglyph's snapshot leases and publication gates interact with splits (a read lease pins a directory epoch). The package would need a hook for that, or Poneglyph keeps its own.
- Keys today are entity hashes, so one hot entity still pins one leaf. The package has the same limit ("a hot key cannot be split").

## Proposed experiments

Follow RFD0005's method: fresh namespaces, nearby B1 controls, admitted-write audits, and no promotion without repeatable wins in both throughput and correctness.

1. **Baseline:** find where today's path saturates (ledger buckets, owner roots or shard leaves) with RFD0005's four scenarios. Without this, a WAL is a guess.
2. **E1, sequencer plus group commit (log A):** one DO per graph appends batches; an applier drains to shards in log order with today's prepare/commit, batched. The receipt waits for publication, so the external contract is unchanged. This isolates the batching win.
3. **E2, deterministic apply:** E1 without 2PC, where shards apply in log order and checks become deterministic outcomes. This measures what dropping coordination buys and what contract changes it forces.
4. **E3, splittable log (log B):** transaction IDs routed through `splittable-object`, with epoch merge. Only if E1 is limited by the sequencer itself.
5. **Incremental schema summary,** maintained by the applier. Useful on its own whichever log wins.

## Open questions

- Is a two-stage acknowledgment (`durable`, then `visible`) acceptable to callers, or must the receipt keep meaning visible?
- Which current rejections can't be made stateless or deterministic?
- Per-graph sequencer location: does the first writer's region pin it?
