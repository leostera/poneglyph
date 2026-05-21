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

### Leveled/background compaction plan

The current implementation has a synchronous full-store `compact()` method. It is useful for correctness and small-store experiments but is not the production shape. The replacement plan is:

1. Extend the manifest from a newest-first flat segment list to level metadata:
   - `L0`: newest-first overlapping flush segments;
   - `L1+`: non-overlapping sorted runs with `smallest_key`/`largest_key`, byte size, record count, and tombstone count.
   - Status: the experimental manifest now stores level vectors plus `smallest_key`/`largest_key` and byte-size metadata for new segments while retaining the flat newest-first compatibility view.
2. Keep flush cheap:
   - `flush_memtable` only writes a new L0 SST and appends a manifest edit;
   - it may enqueue compaction work but should not synchronously compact on the foreground write path unless explicitly requested by tests/tools.
3. Add a background/manual compaction planner:
   - compact L0 when segment count or byte budget is exceeded;
   - compact lower levels by picking overlapping key ranges in the next level;
   - write replacement SSTs first, fsync them, then atomically publish a manifest edit that removes input segments and adds output segments.
   - Status: the experimental planner reports an L0 segment-count compaction plan when the configurable L0 threshold is exceeded. `PONEGLYPH_LSM_L0_COMPACTION_SEGMENTS` controls the threshold, defaulting to 16 to avoid aggressive foreground compaction. `PONEGLYPH_LSM_L0_COMPACTION_MAX_INPUTS` caps each planned maintenance run, defaulting to 4 oldest L0 inputs so one maintenance task does not rewrite every L0 segment. `PONEGLYPH_LSM_L0_COMPACTION_MAX_BYTES` additionally caps the selected oldest inputs by manifest file size, defaulting to 16 MiB and always allowing at least the oldest input when compaction is needed. The plan is exposed through `LsmFactStore::needs_compaction()`. `compact_if_needed()` runs only planned maintenance and returns whether work happened, while `compact_in_background_if_needed()` schedules that planned work on a background thread for explicit callers. Manual `compact()` still executes planned L0 compaction first and falls back to full-store compaction for tests/tools when no plan exists.
4. Split keyspace policies:
   - `log/*` compaction preserves every fact entry and drops only obsolete internal tombstones;
   - `active/*` compaction keeps newest visible entries and can drop shadowed older values/tombstones because active indexes are rebuildable projections.
   - Status: planned L0 compaction now distinguishes active-index tombstones from other keyspaces. Active tombstones are dropped only when no older live segment may contain the same key; otherwise they are preserved so they continue shadowing older active assertions. Non-active tombstones are preserved by default.
5. Preserve crash safety:
   - startup loads the manifest and treats unreferenced SST files as garbage;
   - files referenced by the manifest are never removed until replacement files are durable and published;
   - manifest edits are appended to `MANIFEST.log` and replayed over the latest JSON snapshot on startup; the current implementation snapshots after each edit and clears the log, but the edit-log path now covers interrupted snapshot/publish flows.
6. Add dedicated tests before enabling automatic compaction:
   - crash after output SST write but before manifest publish;
   - crash after manifest publish but before obsolete file deletion;
   - Status: unit coverage now simulates both planned-compaction crash windows: unreferenced output SSTs are ignored after reopen, and manifest-published replacements remain authoritative even if obsolete input SST files were not deleted before crash.
   - overlapping L0 inputs plus L1 outputs preserve newest-visible semantics;
   - active-index rebuild after compaction matches replay from `log/*`.

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
- Planned-compaction reopen stress for multi-level stores.

## Initial implementation phases

1. Add `crates/poneglyph-local/src/facts/lsm/` with key encoding, WAL, memtable, and in-memory/SST-free tests.
2. Implement SST writer/reader and prefix merge iterator.
3. Implement `LsmFactStore` behind the existing `Store` trait.
4. Add backend selection for tests/binaries (`PONEGLYPH_LOCAL_BACKEND=sqlite|lsm` or explicit opener).
5. Run differential correctness tests against SQLite.
6. Add Datafox `FactRequest`-native active scans.
7. Optimize with autoresearch against One Piece single-query latency and ingest throughput.

## Cache and compaction follow-up plan

The first benchmarked LSM backend uses two pragmatic query accelerators:

- a larger memtable flush threshold for medium local working sets;
- an in-memory decoded active-fact cache keyed by active index key.

These are acceptable for the experimental backend but need production bounds before LSM can replace SQLite:

- keep the decoded active cache optionally bounded and invalidate on active-index writes;
- expose cold-query and warm-query metrics separately;
- add segment compaction before lowering the flush threshold for larger datasets;
- prefer active-index compaction/rebuild over preserving derived tombstones indefinitely;
- measure startup/open time after large WAL replay and after SST-heavy compaction;
- optimize SST open/query-after-reopen separately from warm in-process cache performance;
- use persisted segment bounds during reopen/read planning before falling back to deriving bounds from SST contents;
- evaluate mmap/block-cache SST reads instead of always loading whole SST files into memory.

The experimental implementation currently keeps the fastest decoded-active cache path unbounded by default and exposes `PONEGLYPH_LSM_ACTIVE_CACHE_MAX_ENTRIES` as an opt-in safety bound. Autoresearch showed unconditional hot-path bounds regressed the warm One Piece query benchmark, so production policy should remain configurable until a lower-overhead eviction strategy exists. It also exposes `PONEGLYPH_LSM_FLUSH_THRESHOLD_BYTES`; the default is intentionally high for medium local graph workloads but should be revisited once compaction is leveled/background rather than manual full compaction. A prewarmed runtime opener can fill the active cache on startup; this improves first-query latency after reopen but shifts the cost into startup and currently needs better SST scan/index performance. Reopen now uses persisted segment bounds when available, and SST bytes are loaded lazily on first read instead of unconditionally during open. The default reader uses a bounded 256 KiB block cache instead of a whole-file cache, which restores fast compacted reopen and avoids reading unrelated SST bytes during cold scans. `PONEGLYPH_LSM_SST_READ_MODE=mmap` enables an mmap-backed read mode for comparison, and `PONEGLYPH_LSM_SST_BLOCK_CACHE_BLOCKS` tunes the default block-cache bound. Initial 5k-page reopen stress showed mmap slightly faster than the default block cache for first active scans, but both remain in the ~100ms range, so future work should focus on scan/decode volume and active-cache prewarm policy rather than only read transport. A 5k-page planned-compaction stress with the earlier 4-segment threshold performed six foreground L0 compactions in ~45s, reopened in ~14ms, and kept first active-scan latency around ~110ms. Raising the default threshold to 16 reduced this workload to one full-input foreground compaction but still spent ~43s in compaction. Capping planned compaction to four oldest L0 inputs bounded each maintenance run but triggered four runs and still spent ~45s total on the same workload, with first active-scan latency around ~124ms. Adding a 1 MiB planned-input byte budget further bounded each run but increased the number of maintenance runs to 14 and still spent ~43s total, with first active scan around ~117ms. Planned compaction improves open policy and per-run scheduling control, but reducing total work needs a layout that avoids rewriting unrelated keyspaces/ranges, not just smaller batches.

## Open questions

- Whether to persist schema snapshot in the same LSM or keep schema in a separate projection store.
- Whether active indexes should share segment levels with the fact log or use separate column-family-like directories.
- How much transaction isolation/concurrency is required for the first version.
- Whether to use memory-mapped SST reads or buffered file IO initially.
