# RFD0002: Poneglyph Local LSM Fact Store

## Status

Draft.

## Context

Poneglyph's durable truth is an append-only fact log. The current local backend stores facts and active projections in SQLite. Recent benchmarks show SQLite is fast enough to keep as the reference backend, but our read path is now shaped by Datafox `FactRequest`:

```text
predicate / field URI
pattern over tuple columns [entity, value]
mode: tuples | exists
limit and planner hints
snapshot: active
```

This is a specialized graph access pattern. SQLite can serve it with `active_facts(field, ...)` indexes, but each index is a generic B-tree with SQL row/value overhead and write amplification. A Poneglyph-specific LSM can make these requests direct prefix/range scans over encoded keys.

We vendored shallow references under `3rdparty/` for study:

- RocksDB
- LevelDB
- Pebble
- Fjall

## Goals

- Implement a new `poneglyph-local` storage backend optimized for append-only facts and active graph `FactRequest` scans.
- Preserve the current `Store` trait and append-only/replay semantics.
- Keep SQLite as the correctness/reference backend.
- Beat the current One Piece semantic query workload target: single-digit milliseconds per query.
- Keep ingest competitive with tuned SQLite on the One Piece fixture.

## Non-goals

- Do not replace SQLite immediately as the default production backend.
- Do not introduce mutable entity source-of-truth tables.
- Do not build a general-purpose RocksDB clone; optimize for Poneglyph's fact/index workload.
- Do not move graph semantics out of `poneglyph` core.

## Storage model

### Source of truth

Facts remain immutable once committed. Retractions are facts. Transactions group facts with a `tx_id`.

### Persistent derived indexes

Active indexes are persisted for startup speed but are rebuildable from the fact log. Corruption/repair can drop and replay them.

## Proposed keyspaces

All keys are byte-encoded with length-prefixed components to preserve unambiguous lexicographic ordering.

```text
log/tx/{tx_id}/{seq}                         -> encoded Fact
log/fact/{fact_id}                           -> encoded Fact
active/field/{field}/{entity}/{value_key}    -> ActiveEntry
active/entity/{entity}/{field}/{value_key}   -> ActiveEntry
active/value/{field}/{value_key}/{entity}    -> ActiveEntry
schema/{kind}/{uri}                          -> schema snapshot entries
meta/{name}                                  -> manifest/checkpoints/version
```

`value_key` is a canonical typed encoding of `Value`, not JSON text. Reference values use the referenced URI bytes with a distinct type tag.

## FactRequest mapping

```text
field(_, _)          -> prefix active/field/{field}
field(entity, _)     -> prefix active/field/{field}/{entity}
field(_, value)      -> prefix active/value/{field}/{value_key}
field(entity, value) -> point/range active/field/{field}/{entity}/{value_key}
mode = exists        -> stop after first match
limit = N            -> stop after N matches
```

If Datafox later supplies projection columns, the backend can avoid decoding fields not required for tuple construction.

## LSM design

### Components

- Memtable: ordered map from key to record/tombstone.
- WAL: append-only mutation log for the memtable.
- SST segments: immutable sorted key/value files with block index and checksums.
- Manifest: list of live segments, levels, and latest applied tx.
- Compactor: background/manual merge of segments and tombstones.

### Writes

A transaction appends source facts to `log/*`, updates active index mutations for assertions/retractions, writes the WAL, applies to memtable, and returns after durable WAL fsync policy is satisfied.

### Reads

A point/range iterator merges memtable and SST iterators newest-to-oldest, respecting tombstones. Prefix scans are first-class.

### Compaction

- Level 0 accepts flushed memtables.
- Lower levels are non-overlapping sorted ranges.
- Tombstones can be dropped once shadowed entries are gone from older levels.
- Active indexes can compact aggressively because they are derived and latest-state only.

## Correctness plan

- Port existing `Store` conformance/property tests to run against SQLite and LSM backends.
- Differential tests: random fact/retraction sequences must yield identical fact logs and active facts.
- Crash tests: inject process/reopen points around WAL append, manifest update, and segment flush.
- Repair tests: rebuild active indexes from fact log and compare before/after.

## Benchmark plan

- Synthetic prebuilt write stress.
- One Piece fixture ingest from fresh DB.
- One Piece semantic Datafox query benchmark.
- Mixed ingest/query workload.
- Startup/open time with and without active index rebuild.

## Initial implementation phases

1. Add `crates/poneglyph-local/src/facts/lsm/` with key encoding, WAL, memtable, and in-memory/SST-free tests.
2. Implement SST writer/reader and prefix merge iterator.
3. Implement `LsmFactStore` behind the existing `Store` trait.
4. Add backend selection for tests/binaries (`PONEGLYPH_LOCAL_BACKEND=sqlite|lsm` or explicit opener).
5. Run differential correctness tests against SQLite.
6. Add Datafox `FactRequest`-native active scans.
7. Optimize with autoresearch against One Piece single-query latency and ingest throughput.

## Open questions

- Whether to persist schema snapshot in the same LSM or keep schema in a separate projection store.
- Whether active indexes should share segment levels with the fact log or use separate column-family-like directories.
- How much transaction isolation/concurrency is required for the first version.
- Whether to use memory-mapped SST reads or buffered file IO initially.
