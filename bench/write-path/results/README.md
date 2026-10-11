# Write-path evidence

These are **local Miniflare correctness/pilot results, not Cloudflare performance**. No cloud resources were deployed and the full local gate has not passed.

## Version A pilot: 2026-10-11T13-29-10-168Z-1ed33f8e

[Manifest](2026-10-11T13-29-10-168Z-1ed33f8e/manifest.json) · [Summary](2026-10-11T13-29-10-168Z-1ed33f8e/summary.json)

Input: the first 20,000 normal corpus facts, four application Workers, one unsplit graph/database per trial, packaged `stateFacts` client, SQLite DO persistence, eight-attempt retry budget. The entire prepared corpus has 1,530,195 facts; this is a subset. The 10,000-call scenario has one initial wave, not a steady-state saturation sample. Higher logical concurrency is not evidence that 10,000 requests simultaneously reached the database.

| Facts/call × logical concurrency | Acknowledged facts | Acknowledged txs | Local acknowledged facts/s | Calls exhausted/unknown to caller |
| --- | ---: | ---: | ---: | ---: |
| 100 × 1 | 20,000 | 200 | 2,348.45 | 0 |
| 1,000 × 1 | 18,000 | 18 | 1,205.97 | 2 |
| 100 × 10 | 19,400 | 194 | 1,687.10 | 6 |
| 10 × 100 | 16,850 | 1,685 | 558.79 | 315 |
| 10 × 1,000 | 4,750 | 475 | 115.64 | 1,525 |
| 2 × 10,000 | 666 | 333 | 10.29 | 9,667 |

Timing includes bounded retry/backoff and the complete logical-call drain. These are descriptive local rates over incomplete attempted workloads, not successful full-corpus throughput or a database capacity estimate. Retry policy is part of the experiment. Changing it changes the workload.

All persisted transactions matched complete expected fact batches, all acknowledged writes were present, scalar fact/value index counts and associations passed, no prepared/in-progress transactions remained, and audits passed again after runtime restart. No additional unacknowledged commits were found. Exhausted calls were uncommitted at the quiescent audit, but caller uncertainty remains explicitly recorded in the response journals.

The 1,000-fact scenario returned sixteen 503 attempts containing `too many SQL variables`; two batches never committed. A separate 101-distinct-entity test reproduces the capacity-preflight bind-limit defect with no partial writes. The baseline source still contains that defect.

The 10,000-call scenario recorded 49,032 busy responses and 30,329 transport failures over 79,694 attempts. This shows a combined local load-generator/runtime/coordinator overload problem; it does **not** isolate a Cloudflare single-DO ceiling. The original pilot did not record Node CPU/event-loop-delay or nested transport causes. Those diagnostics were added to the subsequent runner; do not invent them for this run. The report's logical latency covers all outcomes, including failed calls, not only successful commits.

Compressed response journals and application/database bundles accompany this complete pilot; manifests record bundle digests. The source tree and data extraction are Version A, with only the client naming addition and read-only audit instrumentation. The original SQLite state is retained locally under ignored `.data/runs/`.

## Full corpus feasibility (not a database load)

[Full preflight](full-corpus-preflight.json) parsed all 1,530,195 facts from 296,624 XML pages.

- No canonical batches exceeded the 1 MB/fact limits in this extraction.
- 1,485 of 1,531 large batches contain over 100 distinct entities, potentially triggering the reproduced bind defect when those entities share a leaf. This input check is not a substitute for resolving actual owner sets.
- Ten-fact calls need 153,020 transactions; two-fact calls need 765,098. Both exceed Version A's 100,000 retained-outcome bound during its seven-day window.

Do not describe this feasibility pass as physically loading the full graph. The subsequent runner now streams batches and uses disk-backed audits. Its default cohort is the user-approved **same 1,000,000 facts per scenario**; [the current concurrent cohort's preflight](1000000-fact-preflight.json) records the retention-limit risk but does not skip or adapt it. Historical 1,000-fact serial batches also exposed the SQL-bind defect. Neither database defect has been patched. A complete matrix must report every planned call and distinguish failed loads from completed ones.

## Interrupted preliminary pilot

[2026-10-11T13-24-43-467Z-adf5a525](2026-10-11T13-24-43-467Z-adf5a525/summary.json) was interrupted at the shell's 240-second execution limit during read-only verification. A quadratic audit lookup was corrected using an existing tuple index. The database's write implementation was not changed. Keep this as an incomplete run, not an additional successful trial.

## Interrupted million-fact serial diagnostic

[2026-10-11T14-08-11-895Z-34f7c2bd](2026-10-11T14-08-11-895Z-34f7c2bd/summary.json) was stopped when the user removed both concurrency-1 load cases. Its complete response journal records **9,057 acknowledged calls / 905,700 facts**, with no rejected or unknown completed calls. A request in flight at termination may have committed without a journaled acknowledgement. No persistence or restart audit was performed; this is **not** a passed correctness result or a completed million-fact comparison. The input, SQLite state, bundles, and compressed journal are retained. Subsequent comparisons use only 100×10, 10×100, 10×1,000, and 2×10,000.

## Gates / next measurements

Package checks passed (34 tests passed, one benchmark test skipped); benchmark tests passed (five, including streamed duplicate/numeric facts and a characterization of the known defect); benchmark TypeScript passed. Passing the defect-characterization test does not make the advertised write contract correct.

The cloud gate remains closed pending the full-input matrix and the remaining protocol/driver/resource gates. No million-fact completion, repeated cloud trial, or Version B result is claimed by the pilot. Every database rejection/overload outcome is part of the current-version result, not permission to resize or skip input. Future product fixes/architecture changes must keep these baseline reports and identify the new version independently.
