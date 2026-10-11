# Final write-path results

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

New completed matrices retain only `final.json`, including final audit evidence; temporary state is removed only after runtimes/ledgers close and the final report is saved. Do not call the corrected implementation a validated correctness baseline until its regression tests and new matrix audits pass. Passing admitted-write audits is distinct from successfully loading every requested fact.

Keep the same 100k cohort for matched iterations. Scale to 1M only after repeated improvement without integrity/recovery regressions. At 100k the two-fact case uses 50,000 transactions, below the unchanged 100,000-outcome quota; the 1M case uses 500,000 and must separately exercise that limitation. No cloud performance or public npm release is claimed.
