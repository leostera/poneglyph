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

Acknowledged facts: **92,100 / 84,200 / 21,070 / 13,410**. Acknowledged facts/s: **983.55 / 432.01 / 139.67 / 44.43**. Relative to nearby B1 control 1: **−13.65% / −2.18% / +102.56% / +358.35%**. All planned calls and admitted-write/restart audits passed; no additional unacknowledged commits or unresolved ledger decisions were found. **All four loads remained incomplete, so C cannot be promoted.** Both repeats are now retained below. Mixed acknowledged rates on incomplete local loads are not successful-load throughput or cloud performance wins; B1 remains the experimental incumbent.

## C comparison: second nearby B1 control

[Control 2 final](2026-10-11T21-44-24-640Z-05e4566c/final.json) identifies `3a8c849`; both Worker bundle digests exactly match control 1. Acknowledged facts: **96,200 / 86,140 / 10,250 / 3,630**. Acknowledged facts/s: **1,297.79 / 474.49 / 50.45 / 10.00**. Every planned call was attempted; admitted-write/restart audits passed without extra unacknowledged commits. All four loads remained incomplete. The identical-bundle controls show local variability, especially at high concurrency; see [RFD0005](../../../docs/rfds/RFD0005-write-path-experiment.md#matched-c-comparison-second-b1-control).

## C pooled ledgers: second repeat and decision

[Repeat 2 final](2026-10-11T22-04-33-078Z-9cf5a858/final.json) identifies `4010c8f`; both Worker bundles exactly match C repeat 1. Acknowledged facts: **92,700 / 87,160 / 20,460 / 14,088**. Acknowledged facts/s: **1,090.08 / 470.69 / 117.43 / 47.42**. Rate changes against nearby B1 control 2: **−16.00% / −0.80% / +132.76% / +374.45%**. Every planned call was attempted; admitted-write/restart audits passed with no additional unacknowledged commits or unresolved decisions.

**C evaluation complete; C is not promoted.** Neither repeat delivered all 100k facts in any scenario. Keep the mixed partial-delivery results and all four fresh-persistence finals, rather than treating high-concurrency acknowledged-rate gains as successful-load throughput wins. [Decision and limitations](../../../docs/rfds/RFD0005-write-path-experiment.md#c-repeat-2-and-promotion-decision): B1 remains the incumbent and is D's base. A is restored as default outside explicit tests/trials.

## D comparison: first nearby B1 control

[Control 1 final](2026-10-11T22-49-05-774Z-35078d69/final.json) identifies `a5c70a3`; both Worker bundles match the earlier B1 controls. It begins the fresh **B1 → D → B1 → D** comparison. Acknowledged facts: **96,900 / 85,130 / 13,120 / 5,146**. Acknowledged facts/s: **1,347.34 / 435.10 / 89.12 / 15.57**. Every planned call was attempted; admitted-write/restart audits passed without extra unacknowledged commits. All four loads remained incomplete. See [RFD0005](../../../docs/rfds/RFD0005-write-path-experiment.md#matched-d-comparison-first-b1-control); this is not a D result or promotion.

## D entity conflicts: first repeat

[Repeat 1 final](2026-10-11T23-07-35-051Z-bfaf2f2a/final.json) identifies `7efbcbd` / `D-narrower-conflict-locks`. Acknowledged facts: **100,000 / 100,000 / 99,580 / 49,384**. Acknowledged facts/s: **1,532.62 / 541.70 / 473.26 / 167.07**. All planned calls and admitted-write/restart audits passed, with no extra unacknowledged commits, leaked entity locks or unresolved decisions.

The first two scenarios completed their full input; the last two did not. **D is not promoted:** the mandatory all-four delivery gate fails in this repeat. High-concurrency acknowledged-rate changes cannot turn incomplete delivery into a successful-load win; tail latency and transport failures remain material. [Qualified comparison](../../../docs/rfds/RFD0005-write-path-experiment.md#d-repeat-1-full-delivery-in-two-cases-no-promotion). The second repeat and decision are retained below.

## D comparison: second nearby B1 control

[Control 2 final](2026-10-11T23-29-04-964Z-7ec0666d/final.json) identifies `09fbb45`; both Worker bundles exactly match D's first B1 control. Acknowledged facts: **96,900 / 86,830 / 12,800 / 5,018**. Acknowledged facts/s: **1,573.40 / 488.93 / 86.06 / 15.23**. Every planned call was attempted; admitted-write/restart audits passed without extra unacknowledged commits. All four loads remained incomplete. [Control details](../../../docs/rfds/RFD0005-write-path-experiment.md#matched-d-comparison-second-b1-control).

## D entity conflicts: second repeat and decision

[Repeat 2 final](2026-10-11T23-46-28-059Z-71e7d580/final.json) identifies `60e42b9`; both Worker bundles exactly match repeat 1. Acknowledged facts: **100,000 / 100,000 / 99,930 / 53,758**. Acknowledged facts/s: **1,636.56 / 636.93 / 600.07 / 183.07**. Every planned call was attempted; admitted-write/restart audits passed without extra unacknowledged commits, leaked entity locks or unresolved decisions.

**D evaluation complete; D is not promoted.** Both repeats completed the medium/small workloads, but neither completed the other two. Preserve the large partial-delivery improvement alongside the higher high-concurrency/saturation caller p95 and remaining transport failures. [Decision and limitations](../../../docs/rfds/RFD0005-write-path-experiment.md#d-repeat-2-and-promotion-decision): the all-four delivery gate fails, so E starts from B1. A remains the default outside explicit trials.

## E comparison: first nearby B1 control

[Control 1 final](2026-10-12T00-36-54-973Z-94051e91/final.json) identifies `d6c085f`. Acknowledged facts: **97,200 / 85,370 / 12,930 / 5,104**. Acknowledged facts/s: **1,553.12 / 463.31 / 88.46 / 15.37**. All planned calls and admitted-write/restart audits passed; no extra unknown commits were reconciled. All loads remained incomplete. [RFD details](../../../docs/rfds/RFD0005-write-path-experiment.md#matched-e-comparison-first-b1-control). This begins B1 → E → B1 → E, not an E result or promotion.

## E atomic leaf authority: first repeat

[Repeat 1 final](2026-10-12T00-54-16-107Z-34414cc8/final.json) identifies `ed69538`. Acknowledged facts: **97,100 / 86,810 / 13,150 / 4,892**. Acknowledged facts/s: **1,420.95 / 492.29 / 90.24 / 14.57**. Every planned call and admitted-write/atomic-membership/restart audit passed; no extra unknown commits were reconciled. All workloads were incomplete. **No promotion:** mixed partial acknowledged rates do not satisfy the all-four delivery gate. [Qualified first pair](../../../docs/rfds/RFD0005-write-path-experiment.md#e-repeat-1-incomplete-delivery-mixed-admitted-rates). The second repeat and decision are retained below.

## E comparison: second nearby B1 control

[Control 2 final](2026-10-12T01-12-49-018Z-a98c4096/final.json) identifies `47cf04d`; both Worker bundles exactly match control 1. Acknowledged facts: **96,800 / 85,910 / 12,560 / 4,688**. Acknowledged facts/s: **1,505.24 / 460.14 / 77.59 / 14.56**. All planned calls and admitted-write/restart audits passed; no extra unknown commits were reconciled. All loads remained incomplete. [Control details](../../../docs/rfds/RFD0005-write-path-experiment.md#matched-e-comparison-second-b1-control).

## E atomic authority: second repeat and decision

[Repeat 2 final](2026-10-12T01-31-18-399Z-482b2d6f/final.json) identifies `7cf5b67`; both Worker bundles exactly match repeat 1. Acknowledged facts: **97,100 / 86,920 / 12,810 / 4,672**. Acknowledged facts/s: **1,543.08 / 490.86 / 83.81 / 14.26**. Every planned call and admitted-write/atomic-membership/restart audit passed; no extra unknown commits were reconciled and no decisions remained unresolved.

**E evaluation complete; no promotion.** All four workloads were incomplete in both repeats. Small/high partial acknowledged rates improved in both pairs, medium direction differed, and saturation rates/delivery fell. Preserve tail latency and transport failures alongside rates; this is not successful-load throughput. [Qualified decision](../../../docs/rfds/RFD0005-write-path-experiment.md#e-repeat-2-and-promotion-decision). F starts from B1; A remains default outside explicit trials.

## F comparison: first nearby B1 control

[Control 1 final](2026-10-12T02-15-00-285Z-e24a464c/final.json) identifies `428e540`. Acknowledged facts: **97,000 / 85,520 / 12,860 / 5,272**. Acknowledged facts/s: **1,329.45 / 441.91 / 82.93 / 15.67**. All planned calls and admitted-write/restart audits passed; no extra unknown commits were reconciled. All loads remained incomplete. [Control details](../../../docs/rfds/RFD0005-write-path-experiment.md#matched-f-comparison-first-b1-control). Begins B1 → F → B1 → F; not an F result or promotion.

## F provisional planning: first repeat

[Repeat 1 final](2026-10-12T02-33-52-343Z-a00ec2c3/final.json) identifies `cfcb98c`. Acknowledged facts: **98,300 / 85,940 / 37,010 / 10,552**. Acknowledged facts/s: **1,528.58 / 477.35 / 145.60 / 30.75**. Every planned call and admitted-write/restart audit passed; no extra unknown commits were reconciled or decisions remained unresolved. All workloads were incomplete. **No promotion:** all rates/partial delivery increased vs nearby B1, but small/high/saturation p95 and high/saturation transport failures were higher. [Qualified first pair](../../../docs/rfds/RFD0005-write-path-experiment.md#f-repeat-1-greater-partial-delivery-no-promotion). The second repeat and decision are retained below.

## F comparison: second nearby B1 control

[Control 2 final](2026-10-12T02-54-15-303Z-ba9568e6/final.json) identifies `f8ed048`; both Worker bundles match control 1. Acknowledged facts: **96,900 / 86,270 / 13,000 / 5,060**. Acknowledged facts/s: **1,555.90 / 481.49 / 87.49 / 15.23**. All planned calls and admitted-write/restart audits passed; no extra unknown commits were reconciled. All loads remained incomplete. [Control details](../../../docs/rfds/RFD0005-write-path-experiment.md#matched-f-comparison-second-b1-control).

## F provisional planning: second repeat and decision

[Repeat 2 final](2026-10-12T03-11-29-100Z-2fd794c1/final.json) identifies `7529e1f`; both Worker bundles exactly match repeat 1. Acknowledged facts: **98,300 / 86,340 / 37,150 / 10,722**. Acknowledged facts/s: **1,617.19 / 508.01 / 149.97 / 32.19**. All planned calls and admitted-write/restart audits passed; no extra unknown commits were reconciled or decisions remained unresolved.

**F evaluation complete; no promotion.** All four workloads were incomplete in both repeats despite repeatably higher partial acknowledged rates/delivery and fewer busy responses. Medium p95 fell, small/high p95 rose, saturation p95 direction differed; high/saturation transport failures increased in both pairs. [Qualified decision](../../../docs/rfds/RFD0005-write-path-experiment.md#f-repeat-2-and-promotion-decision). B1 stays incumbent and A remains default; independent C–F evaluations are complete, not successful-load or cloud certification.

## Final C–F comparison

**All four independent evaluations are complete. No candidate qualifies for promotion.** Each started from B1 and has two unchanged fresh matrices plus two nearby B1 controls. All 16 finals / 64 scenario loads passed admitted-write persistence/index/transaction and restart audits, attempted every planned call, and reconciled zero extra unknown commits. Corpus/reference/settings, application bundle and packaged client are identical across the comparison; all B1 bundles and each candidate's repeated bundles match.

Acknowledged facts out of 100k, repeat 1 / repeat 2:

| Candidate | 100 × 10 | 10 × 100 | 10 × 1,000 | 2 × 10,000 | Full cases / 8 |
| --- | ---: | ---: | ---: | ---: | ---: |
| C | 92,100 / 92,700 | 84,200 / 87,160 | 21,070 / 20,460 | 13,410 / 14,088 | 0 |
| D | **100,000 / 100,000** | **100,000 / 100,000** | 99,580 / 99,930 | 49,384 / 53,758 | 4 |
| E | 97,100 / 97,100 | 86,810 / 86,920 | 13,150 / 12,810 | 4,892 / 4,672 | 0 |
| F | 98,300 / 98,300 | 85,940 / 86,340 | 37,010 / 37,150 | 10,552 / 10,722 | 0 |

The gate requires **8/8 full cases** per candidate, not the best admitted rate or a near-100% high-concurrency load. D's stronger delivery signal and F's repeatable partial-rate gains remain useful evidence, not winners. Preserve each pair's latency, retries/transport and delivery tradeoffs; no successful-load or cloud ranking follows. B1 stays experimental incumbent; A is restored as default. Sources, controlled tests, historical A/B1 finals, corpus cache and final identities remain; only authorized completed-run intermediates/logs were removed after final retention. No push/deployment/publication/1M/default cutover occurred.

[Authoritative final comparison, source/input identities and limitations](../../../docs/rfds/RFD0005-write-path-experiment.md#final-cf-comparison-and-retained-incumbent). G is now separately confirmed after C–F, not part of this completed evaluation. Its amended goal permits experimental promotion on repeatable delivery/rate gains in all four scenarios in both pairs, subject to correctness and mixed-tradeoff judgment; full-delivery certification remains distinct. G's 34 controlled / 56 controlled-plus-shared tests and package/typecheck/seven harness gates pass. Its independent source/protocol and subsequent measured results are in RFD0005.

## G: paired gains, promotion awaiting tradeoff judgment

Fresh sequence (source selections `60972a1` → `e435551` → `99558d5` → `241c5ec`, G corrected gate `f02ddeb`):

- [B1 control 1](./2026-10-12T13-55-23-715Z-4bd7e0b8/final.json)
- [G repeat 1](./2026-10-12T14-18-45-346Z-612f8f61/final.json)
- [B1 control 2](./2026-10-12T14-37-48-924Z-f60c2d09/final.json)
- [Unchanged G repeat 2](./2026-10-12T14-58-03-344Z-04075d57/final.json)

| Frozen scenario | G acknowledged/persisted facts, repeat 1 / 2 (of 100k) | Rate gains against paired B1 controls |
| --- | --- | --- |
| 100 × 10 | 100,000 / 100,000 | +28.2% / +42.4% |
| 10 × 100 | 100,000 / 100,000 | +36.2% / +22.8% |
| 10 × 1,000 | 99,980 / 100,000 | +737.0% / +847.6% |
| 2 × 10,000 | 66,908 / 67,910 | +1,994.5% / +2,352.7% |

All 284,000 planned logical calls across 16 cases were attempted; hot/restart audits pass with persisted=acknowledged, zero extra unacknowledged commits reconciled and no unresolved decisions/owner-ticket anomalies. Both controls and both G bundles/source maps repeat unchanged; corpus, client, application, retry/transport/runtime identities are frozen. Only **5/8 G cases** fully delivered, controls **0/8**. These are paired partial-delivery/rate comparisons, **not full-delivery, equal-success throughput or cloud certification**.

The comparative numerical promotion gate passes, but **G promotion is pending user judgment**: high logical p95 worsened +66.6% / +33.2% and transport failures grew from 36 / 0 to 6,219 / 5,342; saturation p95 rose +0.6% / +4.7%; small repeat 2 added 49 transport failures. Busy/retries/unknown calls fell markedly. Attempt percentile mixtures and full per-scenario counts, physical pooled-ledger accounting and limitations are in the [authoritative G results](../../../docs/rfds/RFD0005-write-path-experiment.md#g-two-repeat-local-results-and-pending-promotion-judgment) and linked finals. B1 remains incumbent pending that decision; A remains default. Further independent improvements/full-delivery proof are still required.

Compact finals and identities are retained; authorized completed intermediates/logs are removed only afterward. Corpus cache and earlier results/implementations stay intact. No retrospective raw replay claim or cloud/default cutover.
