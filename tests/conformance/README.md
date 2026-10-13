# Correctness conformance tests

**Not a benchmark.** These tests check public reads/writes, exact durable membership and restart behavior. They do not measure throughput/latency or make performance promotion decisions.

The authoritative design, tier-first traversal and remaining coverage are in [RFD0005's conformance section](../../docs/rfds/RFD0005-write-path-experiment.md#implementation-neutral-e2e-correctness-suite-design-proposal).

```sh
pnpm --dir poneglyph install --frozen-lockfile
pnpm --dir poneglyph build:package
pnpm --dir tests/conformance install --frozen-lockfile
pnpm --dir tests/conformance typecheck
pnpm --dir tests/conformance test:small
```

`test:small` first runs independent oracle golden/sensitivity tests, then runs the same small-data cases serially against **all A/B1/C–K implementations**, with statically selected bundles and fresh per-implementation SQLite persistence. No backend selection/skipping arguments are accepted. It verifies queries, entity projections and paged fact/index evidence, restarts the disk-backed runtime and repeats public reads/audits.

Results include `results/<run>/summary.json` and a lossless `report.json.gz` with caller operations, actual public answers, failures and source/bundle/runtime identities. Persistence/bundles remain in `.artifacts/<run>/` or a verified lossless `.artifacts/<run>.tar.gz`. Archived runs have `persistence-retention.json.gz` recording every file's original size/SHA256 and the archive hash; duplicate raw directories are removed only after decompressed-file verification. Restore an archived snapshot into `.artifacts/` with `tar -xzf .artifacts/<run>.tar.gz -C .artifacts` from this directory (do not overwrite an existing run). Unsuccessful runs remain evidence; a later passing run does not erase them.

Latest checkpoint: [`2026-10-13T01-23-07.238Z`](results/2026-10-13T01-23-07.238Z/summary.json), revision `0e4aac3`, passed **54 warm and 54 cold phase checks per implementation** after repairing shared clean-EOF truncation acceptance. Warm coverage includes five actual shard-response faults; cold phases replay healthy public reads/audits with faults cleared, not reinjection of faults. [Selected controlled gates](results/controlled-completed-scans/summary.json) also pass for every implementation. Details, failed baselines and the internal completion protocol are in the RFD.

This is an initial small-tier foundation, **not the complete proposed suite**. Controlled internal write-phase faults, actual abrupt-process recovery, forced splits and bounded concurrency-history checks still need shared coverage before advancing to larger data tiers. Existing implementation-private fixtures are supplemental; for example:

```sh
PONEGLYPH_CORRECTNESS_IMPLEMENTATION=G pnpm --dir poneglyph exec vitest run --config vitest.correctness.config.ts
```

That configuration explicitly selects applicable private fixtures plus shared pure tests. It does not replace or filter the all-implementation public E2E matrix.
