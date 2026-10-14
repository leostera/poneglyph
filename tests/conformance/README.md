# Correctness conformance tests

**Not a benchmark.** Public read/write tests use an independent oracle, exact typed binding multisets, projections, complete durable membership and real disk-backed recovery. There is one production implementation under `poneglyph/src/storage/`, promoted from G; no backend selectors or alternative bundles remain. See [RFD0005's current direction](../../docs/rfds/RFD0005-write-path-experiment.md#current-direction-one-implementation-2026-10-14).

## Development loop

```sh
pnpm --dir poneglyph build:package
pnpm --dir tests/conformance install --frozen-lockfile
pnpm --dir tests/conformance typecheck
pnpm --dir tests/conformance test:oracle
pnpm --dir tests/conformance test:focused
```

The focused runner uses the actual production composition and the same shared assertions. Its default four cases cover three bounded legal concurrent histories plus a causal partial-participant process crash/recovery, warm/cold. It is explicitly **not full-tier certification**. The canonical package's controlled storage/schema/retention/client/TODO tests run normally, without an implementation selection flag:

```sh
pnpm --dir poneglyph test
```

## Certification checkpoint

Only run the complete gate at an explicit coverage/repair checkpoint:

```sh
pnpm --dir tests/conformance test:small
```

This runs all **68 declared cases** against one fresh disk-backed production composition, warm and after full restart. It does not silently select cases. Fail-fast stops new cases/retries, drains admitted callers, closes the runtime and retains causal failures/cleanup diagnostics. Expected injected errors must satisfy their assertions. Unknown transport is never fabricated as abort or acknowledged delivery. A failed or unexecuted tail is not passing coverage.

The current cases still do **not** complete comprehensive small coverage; broader admission/decision/publication/release, topology/client/retention controls and later stateful/boundary/100k tiers remain pending. The independent oracle and declared limits are unchanged by the one-implementation cutover.

## Retained evidence

Results contain source/bundle/runtime identities, actual answers, caller outcomes and native lifecycle evidence. Certification reports use `formatVersion: 2` and must contain exactly `poneglyph`. The archiver reads older all-eleven reports only as historical evidence—not selectable implementations. Focused reports remain separately labelled.

Historical final all-eleven gate: [2026-10-13T19-14-06.137Z](results/2026-10-13T19-14-06.137Z/summary.json), **1,496 phases**, **74 oracle checks**, **33 actual process-group kills**. [Historical focused evidence](results/focused-controls-2026-10-13T19-06-31.498Z/summary.json) passed 88 phases. These passes do not erase earlier transport, resource, adapter, interrupted or finalization failures, and do not certify the renamed production bundle without new validation.

Full reports are losslessly retained as `report.json.gz`; persistence/bundles remain under `.artifacts/<run>/` or a verified `.artifacts/<run>.tar.gz`. `persistence-retention.json.gz` records file sizes/hashes and archive verification. Raw duplicates are removed only after decompressed verification and unchanged-original recheck. Restore from this directory with `tar -xzf .artifacts/<run>.tar.gz -C .artifacts`, never overwriting an existing run. Archival is not product replay or elapsed-retention/hosted-durability proof.
