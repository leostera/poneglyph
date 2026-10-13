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

Results include `results/<run>/summary.json` and a lossless `report.json.gz` with caller operations, actual public answers, failures and source/bundle/runtime identities. `.artifacts/<run>/` retains persistence and bundles for diagnosis. Unsuccessful runs remain evidence; a later passing run does not erase them.

This is an initial small-tier foundation, **not the complete proposed suite**. Controlled internal phase faults, forced splits and bounded concurrency-history checks still need shared coverage before advancing to larger data tiers. Existing implementation-private fixtures are supplemental; for example:

```sh
PONEGLYPH_CORRECTNESS_IMPLEMENTATION=G pnpm --dir poneglyph exec vitest run --config vitest.correctness.config.ts
```

That configuration explicitly selects applicable private fixtures plus shared pure tests. It does not replace or filter the all-implementation public E2E matrix.
