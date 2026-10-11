# Final write-path results

Measurement tables, audit scope, retention rules, and interpretation are reflected in [RFD0005](../../../docs/rfds/RFD0005-write-path-experiment.md#final-evidence-retention-and-interpretation). This README also indexes the final JSON files.

## Pre-fix Version A: 100k concurrent matrix

[Final report](2026-10-11T17-19-03-682Z-64195105/final.json) retains source/dataset/artifact digests, final metrics, response classifications, and persisted fact/index audits before/after restart. Raw journals, SQLite state, reference ledgers, bundles, progress samples, and console logs were removed at the user's request. This is **local Miniflare evidence, not Cloudflare performance**.

Each case attempted the same 100,000 facts through four application Workers into one fresh graph/database, using the packaged client and unchanged pre-fix storage implementation.

| Facts/call × concurrency | Acknowledged facts | Exhausted/unknown calls | Local acknowledged facts/s | Persistence + restart audits |
| --- | ---: | ---: | ---: | --- |
| 100 × 10 | 93,900 | 61 | 1,292.44 | Passed |
| 10 × 100 | 67,940 | 3,206 | 303.61 | Passed |
| 10 × 1,000 | 5,740 | 9,426 | 29.13 | Passed |
| 2 × 10,000 | 2,398 | 48,801 | 8.39 | Passed |

Every planned call was attempted. **None completed the full load.** Audits found all acknowledged facts, no extra unacknowledged commits, complete transaction membership, consistent scalar fact/value indices, and no unresolved transaction phases. All caller-unknown calls were uncommitted at the quiescent audit. Successful persistence does not make an incomplete load a throughput winner. Local transport/runtime limits may contribute to high-concurrency failures.

## Corrected implementation / next baseline

The next revision fixes SQL binding-page limits, participant prepare replay ordering, retained coordinator outcome replay under pressure, explicit server retryability handling, and post-commit maintenance error handling. Global coordinator architecture and storage/transaction/retention limits are unchanged. The pre-fix final report remains a historical comparison, not evidence for the corrected revision.

[Corrected final report](2026-10-11T17-58-33-656Z-8f2fb877/final.json) identifies revision `a21b9a6`. Package checks passed **39 tests (one skipped)** and the harness passed **6 tests**, including final-only retention. All four new corpus cases passed fact/index/transaction and restart audits with no additional unacknowledged commits or unresolved decisions.

| Facts/call × concurrency | Acknowledged facts | Exhausted/unknown calls | Local acknowledged facts/s |
| --- | ---: | ---: | ---: |
| 100 × 10 | 93,700 | 63 | 1,286.11 |
| 10 × 100 | 68,780 | 3,122 | 310.48 |
| 10 × 1,000 | 5,820 | 9,418 | 30.14 |
| 2 × 10,000 | 2,298 | 48,851 | 8.03 |

**This is the correctness baseline for the exercised invariants, not a successful full-load or universal correctness guarantee.** None of the four cases completed its full input. Small throughput differences from the pre-fix run are not evidence of improvement from a single local pair; coordinator contention and local transport limitations remain. Future architectural changes must match or strengthen these durable-write/replay/recovery checks and improve complete-load behavior.

Completed matrices retain only `final.json`, including final audit evidence; temporary state is removed only after runtimes/ledgers close and the final report is saved. Both matrices' intermediates and runtime logs have been removed.

## B1 independent subtrees: first 100k candidate trial

[Final report](2026-10-11T19-06-36-247Z-041e975c/final.json) identifies clean bundled revision `c6b5680` and `B1-independent-subtrees`. Protocol, audit-adapter differences, the complete A/B1 comparison, and limitations are recorded in [RFD0005](../../../docs/rfds/RFD0005-write-path-experiment.md#first-b1-100k-result--2026-10-11).

All planned calls were attempted and all four persistence/restart audits passed. Acknowledged facts were **94,300 / 85,930 / 12,840 / 4,446**; acknowledged facts/s were **1,032.86 / 449.55 / 84.28 / 13.21**. Compared with the historical corrected A run, rates changed **−19.69% / +44.79% / +179.60% / +64.50%**. None delivered all 100k facts. One local run with a medium-batch regression is not a throughput winner, repeatable improvement, or cloud performance evidence. Version A remains the default; candidate transaction-object storage cost is not fully accounted by these reports. Raw artifacts and console logs were removed after final retention.

Keep the same 100k cohort for matched iterations. Scale to 1M only after repeated improvement without integrity/recovery regressions. At 100k the two-fact case uses 50,000 transactions, below the unchanged 100,000-outcome quota; the 1M case uses 500,000 and must separately exercise that limitation. No cloud performance or public npm release is claimed.

## C comparison: first nearby B1 control

[Control 1 final](2026-10-11T21-03-13-418Z-60d4bcdd/final.json) identifies clean source composition `c08e89c` and the unchanged B1 runtime. It begins the planned **B1 → C → B1 → C** fresh-persistence comparison, documented in [RFD0005](../../../docs/rfds/RFD0005-write-path-experiment.md#matched-c-comparison-trial-order-and-first-control).

Acknowledged facts: **95,400 / 85,500 / 12,780 / 3,572**. Acknowledged facts/s: **1,139.03 / 441.63 / 68.95 / 9.69**. All planned calls were attempted; admitted-write and restart audits passed, with no additional unacknowledged commits. **None completed full delivery.** This control is neither a C result nor evidence of promotion. Compact final evidence is retained; the historical B1 run does not replace the planned second nearby control.

## C pooled ledgers: first repeat

[C repeat 1 final](2026-10-11T21-25-46-207Z-39cf9027/final.json) identifies `2772a54` / `C-pooled-coordinator-ledgers`; [interpretation](../../../docs/rfds/RFD0005-write-path-experiment.md#c-repeat-1-mixed-partial-delivery-result-no-promotion).

Acknowledged facts: **92,100 / 84,200 / 21,070 / 13,410**. Acknowledged facts/s: **983.55 / 432.01 / 139.67 / 44.43**. Relative to nearby B1 control 1: **−13.65% / −2.18% / +102.56% / +358.35%**. All planned calls and admitted-write/restart audits passed; no additional unacknowledged commits or unresolved ledger decisions were found. **All four loads remained incomplete, so C cannot be promoted.** The second C repeat is still required. Mixed acknowledged rates on incomplete local loads are not successful-load throughput or cloud performance wins; B1 remains the experimental incumbent.

## C comparison: second nearby B1 control

[Control 2 final](2026-10-11T21-44-24-640Z-05e4566c/final.json) identifies `3a8c849`; both Worker bundle digests exactly match control 1. Acknowledged facts: **96,200 / 86,140 / 10,250 / 3,630**. Acknowledged facts/s: **1,297.79 / 474.49 / 50.45 / 10.00**. Every planned call was attempted; admitted-write/restart audits passed without extra unacknowledged commits. All four loads remained incomplete. The identical-bundle controls show local variability, especially at high concurrency; see [RFD0005](../../../docs/rfds/RFD0005-write-path-experiment.md#matched-c-comparison-second-b1-control).
