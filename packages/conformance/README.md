# Correctness conformance tests

**Not a benchmark.** Public read/write tests use an independent oracle, exact typed binding multisets, projections, complete durable membership and real disk-backed recovery. There is one production implementation under `packages/poneglyph/src/storage/`, promoted from G; no backend selectors or alternative bundles remain. See [RFD0005's current direction](../../docs/rfds/RFD0005-write-path-experiment.md#current-direction-one-implementation-2026-10-14).

## Development loop

```sh
bun install --frozen-lockfile
bun run typecheck
bun run --cwd packages/conformance test:oracle
bun run test:focused
```

The focused runner uses the actual production composition and the same shared assertions. Its default four cases cover three bounded legal concurrent histories plus a causal partial-participant process crash/recovery, warm/cold. It is explicitly **not full-tier certification**. The canonical package's controlled storage/schema/retention/client/TODO tests run normally, without an implementation selection flag:

```sh
bun run --cwd packages/poneglyph test
```

## Certification checkpoint

Only run the complete gate at an explicit coverage/repair checkpoint:

```sh
bun run test:small
```

This runs all **68 declared cases** against one fresh disk-backed production composition, warm and after full restart. It does not silently select cases. Fail-fast stops new cases/retries, drains admitted callers, closes the runtime and retains causal failures/cleanup diagnostics. Expected injected errors must satisfy their assertions. Unknown transport is never fabricated as abort or acknowledged delivery. A failed or unexecuted tail is not passing coverage.

The current cases still do **not** complete comprehensive small coverage; broader admission/decision/publication/release, topology/client/retention controls and later stateful/boundary/100k tiers remain pending. The independent oracle and declared limits are unchanged by the one-implementation cutover.

## Latest canonical checkpoint

[2026-10-14T07-14-58.060Z](results/2026-10-14T07-14-58.060Z/summary.json), revision `7bd9678`: **68 warm + 68 cold checks / 136 phases**, zero failures or unexecuted phases; **80 package tests** and **76 oracle/adapter tests** pass. The only package skip is the opt-in benchmark. Includes three actual process-group crashes and exact recovery. Public-request trace: **192.978 seconds**, an execution diagnostic—not a throughput comparison. Logs/hashes and closed raw persistence are retained. This passes the current gate; comprehensive-small coverage and larger tiers remain unfinished.

## Retained evidence

Reports predating the workspace move keep their original digests, identities and recorded `tests/conformance/` paths unchanged. The evidence now lives here; relocation is not a new test run or product replay. Node remains the native host runtime; Bun installs dependencies and orchestrates scripts. New report source identities include the root `bun.lock` and workspace manifest.

Results contain source/bundle/runtime identities, actual answers, caller outcomes and native lifecycle evidence. Certification reports use `formatVersion: 2` and must contain exactly `poneglyph`. The archiver reads older all-eleven reports only as historical evidence—not selectable implementations. Focused reports remain separately labelled.

Historical final all-eleven gate: [2026-10-13T19-14-06.137Z](results/2026-10-13T19-14-06.137Z/summary.json), **1,496 phases**, **74 oracle checks**, **33 actual process-group kills**. [Historical focused evidence](results/focused-controls-2026-10-13T19-06-31.498Z/summary.json) passed 88 phases. These passes do not erase earlier transport, resource, adapter, interrupted or finalization failures, and do not certify the renamed production bundle without new validation.

Full reports are losslessly retained as `report.json.gz`; persistence/bundles remain under `.artifacts/<run>/` or a verified `.artifacts/<run>.tar.gz`. `persistence-retention.json.gz` records file sizes/hashes and archive verification. Raw duplicates are removed only after decompressed verification and unchanged-original recheck. Restore from this directory with `tar -xzf .artifacts/<run>.tar.gz -C .artifacts`, never overwriting an existing run. Archival is not product replay or elapsed-retention/hosted-durability proof.
