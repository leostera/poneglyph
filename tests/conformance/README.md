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

`test:small` first runs independent oracle golden/sensitivity tests, then runs the same small-data cases serially against **all A/B1/C–K implementations**, with statically selected bundles and fresh per-implementation SQLite persistence. No backend selection/skipping arguments are accepted. It verifies queries, entity projections and paged fact/index evidence, restarts the disk-backed runtime and repeats public reads/audits. **Fail-fast:** the first unexpected assertion/runtime failure stops later cases/backends, drains existing callers without starting new retries, closes the runtime and retains failed-prefix evidence. Expected injected errors must still satisfy their scenario assertions. After a repair, rerun the whole shared tier; an unexecuted tail is not passing or skipped coverage.

Results include `results/<run>/summary.json` and a lossless `report.json.gz` with caller operations, actual public answers, failures and source/bundle/runtime identities. Persistence/bundles remain in `.artifacts/<run>/` or a verified lossless `.artifacts/<run>.tar.gz`. Archived runs have `persistence-retention.json.gz` recording every file's original size/SHA256 and the archive hash; duplicate raw directories are removed only after decompressed-file verification. Restore an archived snapshot into `.artifacts/` with `tar -xzf .artifacts/<run>.tar.gz -C .artifacts` from this directory (do not overwrite an existing run). Unsuccessful runs remain evidence; a later passing run does not erase them.

Latest checkpoint: [`2026-10-13T17-31-49.598Z`](results/2026-10-13T17-31-49.598Z/summary.json), revision `aabfafc`, passed **64 warm and 64 cold phase checks per implementation** (**1,408 total**) and **60 oracle/adapter/sensitivity unit checks**, with complete fail-fast execution, no unexecuted phases and successful terminal archival. The new warm cases record **22 actual SIGKILL host/workerd process-group crashes**, after acknowledgment and held native apply, followed by exact durable reconstruction/replay. Original lost callers remain unknown; later original-identity replay receipts are separate delivery evidence. Earlier transport-stop and report-finalization failures remain retained as failed evidence; later passes do not erase them. Final warm/cold checks now include canonical outcome/digest/receipt reconciliation and exact pending-authority/owner-witness audits; I's deferred pruning-proof cache is not confused with actual owner release. Warm cases include five actual shard-response faults, native prepared/applied reply barriers, overlapping admitted-identity histories, two nested splits, interrupted native copy/resume and actual actor reset/reconstruction after acknowledgment and while a verified apply reply is held. Cold phases replay healthy public reads/audits after full disk runtime restart, not reinjection of in-flight controls. [Selected controlled gates](results/controlled-completed-scans/summary.json) also pass for every implementation. Details, failed/interrupted baselines and bounded evidence are in the RFD; later green runs do not erase earlier transport failures.

Fast development regression: `pnpm --dir tests/conformance test:histories` runs the three new legal concurrent-history cases across all eleven, warm/cold, with independent complete history alternatives and exact audits. [Focused evidence](results/focused-histories-2026-10-13T18-45-52.566Z/summary.json) passes 66 phases and 68 unit checks; it is **not full-tier certification**. The complete small matrix now has 67 cases and must rerun at the next shared coverage checkpoint. Duplicate final-replay specifications are removed, but every explicit historical read and all distinct cold query specifications still execute and compare their exact typed multisets.

This is an initial small-tier foundation, **not the complete proposed suite**. Write failures across admission/decision/publication/release, broader abrupt-process recovery stages, actor/finalization failure stages, stale/mixed migration phases and general bounded concurrency histories still need shared coverage before advancing to larger data tiers. Existing implementation-private fixtures are supplemental; for example:

```sh
PONEGLYPH_CORRECTNESS_IMPLEMENTATION=G pnpm --dir poneglyph exec vitest run --config vitest.correctness.config.ts
```

That configuration explicitly selects applicable private fixtures plus shared pure tests. It does not replace or filter the all-implementation public E2E matrix.
