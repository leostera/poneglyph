# RFD0005: Repeatable Write-Path Experiment

## Status

Accepted experiment design (2026-10-11), revised to a clean **100,000-fact concurrent-only iteration**. The application/client/database path, four load scenarios, disk-backed fact/index audits, and report saving are implemented under `bench/write-path/`. At the user's explicit request, earlier generated reports, journals, SQLite trial state, archives, and logs were deleted; corpus inputs and harness code were retained. The pre-fix and separately identified corrected revisions each completed a fresh-storage 100k matrix. Both passed admitted-write persistence/restart audits; neither completed the full input. No database adaptation was made within a trial. Scale to 1M only after a design is repeatably better in throughput and durable correctness/recovery. This write-path Cloudflare benchmark has not been deployed or measured, and the parallel-store candidate is not implemented. This RFD does not authorize account changes by itself; cloud execution requires the local and resource/cost gates below.

## Confirmed C–F experiment contract (2026-10-11)

The user selected **B1 as the initial experimental incumbent**, despite its incomplete delivery. Candidates are measured against the **last winner**, not automatically against their predecessor. Each candidate is an independent duplicate of the incumbent selected when that experiment starts. Preserve A, B1, every candidate, and source-identified evidence; a losing change does not become the next candidate's base.

| Candidate | Isolated change |
| --- | --- |
| C | Sharded multi-transaction coordinator ledgers instead of DO-per-transaction. Preserve B1's subtree gates, sequences, participant protocol, and leased query cut. |
| D | Narrower complete fact/index/projection conflict locks, with an explicitly specified atomic-visibility and topology-fencing protocol. |
| E | Idempotent single-owner atomic commit, including graph-wide payload-bound identity, local decision authority/delegation, lost-response replay, and migration-safe outcomes. |
| F | Plan before taking long-held gates and remove redundant staging/rereads. Provisional routes must be revalidated before preparation/mutation. |

For every candidate, run at least **two** independent fresh-persistence matrices with the same 100,000-fact prefix, four concurrent scenarios, four application Workers, packaged client, HTTP/service-binding transport, batch sizes, caller IDs, retry/backoff/timeout settings, and timed path. Obtain repeated incumbent controls close to the comparison; interleave incumbent/candidate trials and record their order. Do not run competing load/tests concurrently or patch an active SUT. Identify product corrections as new revisions, validate again, and do not pool their measurements with the previous revision.

**Promotion requires 100% acknowledged and durably persisted delivery in all four scenarios in both repeats**, plus all fact/index/transaction/atomic-visibility/recovery/topology gates. If the incumbent also completes the input, require repeatable performance benefit; ask the user to judge mixed rate/latency tradeoffs. These are promotion gates, not a promise every experiment will succeed. An incomplete/regressing candidate stays isolated and the next experiment starts from the unchanged incumbent. The sequence is complete when all four candidates have been implemented, evaluated, and documented, even if none is promoted. Choosing an experimental winner does not authorize changing the production/default composition.

Maintain one graph/database per case, append-only facts, all required indices, one durable recoverable transaction decision, payload-bound idempotency, required apply before success, atomic query visibility, and migration fencing. Existing fact/byte/participant/storage/query/retention ceilings stay fixed unless explicitly changed by the user. The seven-day window concerns transaction identity/outcome records, **not deletion of facts**. No import endpoint, input-delivery queue, rebatching/skipping, request-time backend selection, silent fallback, success-before-apply, or distributed graph IDs are allowed. Schema-specific read-only audit wiring/report identities may change only to preserve or strengthen the independent checks, never timed delivery behavior.

Use explicit source composition and fresh namespaces/persistence. Test baseline/composition integrity, applicable shared package behavior, unchanged harness semantics, and each candidate's held-participant/overlap/replay/fault/read/topology invariants before measuring. Baseline coordinator SQL and graph-global sequence fixtures are tested with A; they cannot certify a different candidate representation. Explain any representation-specific test selection. Retain source/corpus/artifact identities and compact final aggregates before removing completed-run intermediates; retain the corpus cache. Record caller-unknown commits and bounded background recovery separately from acknowledged throughput. Do not describe admitted-write audits as full-input delivery.

Contract checkpoint validation: default A passed `pnpm check` (41 tests, six explicit skips: the historical benchmark plus five B1-only protocol cases), package build, and six harness tests. Explicit B1 selection passed typecheck, all 27 tests across shared client/fact/Datalog and B1 controlled-protocol suites, and the same six harness tests. A-specific storage/coordinator/schema fixtures remain exercised with A rather than asserted against B1's changed representation. Restored default A after validation; no new performance trial is implied by these fixtures. Future summary wording says **admitted-write persistence checks**, not the misleading historic “full-input persistence gates passed”; retained historical reports are unchanged.

The scope remains local Miniflare, not cloud performance. No 1M scale-up, cloud deployment, publication, push, unrelated changes, or history rewriting is authorized. Stop and ask when a correctness/visibility contract cannot be verified, a frozen workload/limit needs changing, a mixed-result promotion needs judgment, or work needs extra resource authorization. Incomplete load alone is an experiment result, not a reason to stop the whole sequence or silently relax the promotion gate.

## C protocol: pooled transaction ledgers

C is a fresh, independent copy of B1 under `poneglyph/src/storage-c/`. It keeps the sixteen entity-owner gates, colocated fact/EA/AV projections, subtree sequences, participant prepare/apply/publication protocol, split fencing, and sixteen-owner leased query cut unchanged. New schema-kind markers/version 3 and routing version 4 reject incompatible persistence; there is no in-place migration or request-time implementation selector.

A graph has **sixteen fixed transaction ledgers**, chosen by the first hexadecimal digit of SHA-256 of the caller transaction ID. The graph-scoped name is stable across retries and recovery. A ledger durably binds its graph/bucket role on first transaction use. Every intent lookup, phase transition, plan update, and deletion includes its transaction ID. Per-ID execution guards share an engine only among concurrent calls for that identity; awaiting one participant does not reserve the ledger for other IDs. Payload binding and terminal receipts are checked before same-ID busy admission. Tree-owner conflicts, including fact/index/projection participants, remain B1's conflicts, not ledger-shard locks.

A ledger conservatively allows at most **6,250 total intent/outcome rows**, including unfinished work, within the existing graph's 100,000-record allowance, and retains the existing accounted 8-GB per-object ceiling. It rejects rather than overcommits its allocation. B1's separate 6,250-outcome owner allocations and all fact/byte/participant/query limits remain unchanged; duplicated placement may exhaust an owner sooner than a ledger. No quota is raised. The fixed matrix's transaction counts fit the aggregate allowance, but no full-delivery claim follows from that accounting. Unadmitted temporary failures remove only their own ledger row; cancellation/terminal records preserve payload binding.

An alarm is durably scheduled **after persisting an intent and before participant I/O**. Recovery rebuilds each transaction from SQL, scans at most 100 due intents, and drives at most six concurrently. Claiming a recovery step moves that identity's deadline five seconds forward; an identity with an active caller is left to that caller. A ten-second dispatch-start budget stops starting further work, but does not pretend to cancel or wall-clock-bound already awaited subrequests. Accepted commits/cancellations still finish through the ordinary participant protocol; an alarm cannot admit alternate input, count a caller-unknown commit as acknowledged throughput, or acknowledge before required apply/publication. One unfinished identity cannot expire or be discarded by retention.

Terminal identity sweeping deletes at most 100 expired complete/aborted ledger rows per alarm, excludes active identities, and reschedules remaining recovery/expiry deadlines using the single per-object alarm. Seven days is the existing transaction identity window, not fact lifetime. The sweep never touches fact or projection rows. Recovery alarms are at-least-once; durable phases and idempotent participant messages remain authoritative.

The read-only audit probes exact IDs and also enumerates **all sixteen ledger summaries**, rejecting unresolved intents even if not referenced by an owner. It aggregates their physical SQLite bytes instead of repeating B1's unmeasured per-transaction-object byte omission. The timed application/client transport and logical workload are unchanged. Report identity derives from the sole coordinator implementation actually bundled; unknown or mixed composition fails rather than falling back to label A. The first C load result is recorded below; it is not a promotion.

C pre-load validation: explicit C composition passed typecheck, **34 tests** across the shared client/fact/Datalog suites and **12 C-controlled tests**, package build, and all **seven harness tests**. Controlled cases cover same-ledger disjoint progress while another commit is held; overlap and changed payload; abort isolation; partial prepare/apply/publication and actual eviction; caller-discarded receipt replay; terminal-maintenance failure without failed acknowledgement; interrupted split progress; leased-cut fencing; schema-marker rejection; 100-row/six-drive recovery bounds; and a 100-row terminal sweep preserving unfinished identities and facts. Metadata-only fixtures for dispatch/sweep bounds are explicitly synthetic and are not delivered-write evidence. After restoring default A, `pnpm check` passed **41 tests / 18 explicit skips** (five B1-only, twelve C-only, one historical benchmark), package build and seven harness tests. A-specific global-sequence/coordinator-schema fixtures remain an A gate, not a claim of C certification. No measured matrix ran concurrently with these tests.

### Matched C comparison: trial order and first control

Planned order is **B1 control 1 → C repeat 1 → B1 control 2 → C repeat 2**, each with fresh persistence. The first control completed at clean selected revision `c08e89c`, with the B1 runtime unchanged from `c6b5680`; [final report](../../bench/write-path/results/2026-10-11T21-03-13-418Z-60d4bcdd/final.json). It attempted every planned call and passed admitted-write fact/index/transaction audits before/after restart, with zero reconciled unacknowledged commits. None of its four cases delivered the full input. This is an incumbent control, not a C result or promotion.

| Facts/call × concurrency | B1 control 1 acknowledged facts | Unknown calls | Acknowledged facts/s | Logical p95 (s) |
| --- | ---: | ---: | ---: | ---: |
| 100 × 10 | 95,400 | 46 | 1,139.03 | 4.62 |
| 10 × 100 | 85,500 | 1,450 | 441.63 | 7.72 |
| 10 × 1,000 | 12,780 | 8,722 | 68.95 | 23.65 |
| 2 × 10,000 | 3,572 | 48,214 | 9.69 | 83.20 |

Attempts were 2,591 / 40,399 / 76,313 / 394,358; busy responses were 1,637 / 31,849 / 75,003 / 88,410; transport failures were 0 / 0 / 32 / 304,162. The unchanged retry budget was exhausted for the unknown calls. Keep these delivery and local-runtime failures separate from acknowledged throughput. Source/corpus/client/bundle identities are retained in the final JSON. The historical B1 trial is not substituted for the second nearby control.

### C repeat 1: mixed partial-delivery result, no promotion

[Final report](../../bench/write-path/results/2026-10-11T21-25-46-207Z-39cf9027/final.json) identifies `C-pooled-coordinator-ledgers` and selected revision `2772a54` (C runtime `948a183`). The tracked SUT was unchanged during the run. The recorded worktree status includes unrelated untracked documents/lockfile; these were not bundled, modified, or removed by this experiment. The packaged client digest is identical to the preceding B1 control.

All planned calls were attempted. Both admitted-write and restart audits passed in every case, with persisted facts matching acknowledgements, zero reconciled unacknowledged commits, and no unresolved owner or pooled-ledger decisions. **No scenario delivered all 100,000 facts; C fails the mandatory promotion gate already in this repeat.** The second nearby control/repeat pair is recorded below; the first mixed local pair alone is not a repeatable performance conclusion.

| Facts/call × concurrency | C repeat 1 acknowledged facts | Unknown calls | Acknowledged facts/s | Rate change vs B1 control 1 | Logical p95 (s) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 × 10 | 92,100 | 79 | 983.55 | −13.65% | 6.46 |
| 10 × 100 | 84,200 | 1,580 | 432.01 | −2.18% | 8.02 |
| 10 × 1,000 | 21,070 | 7,893 | 139.67 | +102.56% | 24.28 |
| 2 × 10,000 | 13,410 | 43,295 | 44.43 | +358.35% | 74.04 |

C delivered fewer facts and lower rates in the first two cases, more in the last two. These are acknowledged rates on **incomplete loads**, not successful-load throughput wins. Attempts: 1,974 / 39,464 / 73,260 / 377,013. Busy responses: 1,053 / 31,044 / 71,138 / 176,927. Transport failures: 0 / 0 / 15 / 193,381. All terminal caller failures were unknown after the unchanged retry budget; no quota increase or alternate delivery path was used.

All sixteen ledgers were audited. Their combined physical SQLite bytes were **45,838,336 / 40,050,688 / 10,215,424 / 8,622,080** across the four cases. This closes C's ledger-byte accounting omission, but does **not** quantify a storage reduction against B1: B1's per-transaction-object bytes were not aggregated. Recovery fault tests demonstrate the exercised protocol; this measured repeat did not observe extra caller-unknown commits completed by background recovery. B1 remains the experimental incumbent; no default/production cutover, cloud performance claim, or scale-up is authorized.

### Matched C comparison: second B1 control

[Control 2 final](../../bench/write-path/results/2026-10-11T21-44-24-640Z-05e4566c/final.json) identifies selected revision `3a8c849`. **Both Worker bundle digests exactly match control 1**, including the packaged application/client path; the B1 runtime was not patched. Unrelated untracked video documents are recorded in worktree status, not bundled into the SUT.

| Facts/call × concurrency | B1 control 2 acknowledged facts | Unknown calls | Acknowledged facts/s | Logical p95 (s) |
| --- | ---: | ---: | ---: | ---: |
| 100 × 10 | 96,200 | 38 | 1,297.79 | 4.55 |
| 10 × 100 | 86,140 | 1,386 | 474.49 | 7.43 |
| 10 × 1,000 | 10,250 | 8,975 | 50.45 | 38.95 |
| 2 × 10,000 | 3,630 | 48,185 | 10.00 | 85.58 |

Every planned call was attempted; all admitted-write and restart audits passed, with zero reconciled unacknowledged commits. All loads were incomplete. Attempts: 2,491 / 39,827 / 76,616 / 394,283. Busy responses: 1,529 / 31,213 / 74,285 / 95,364. Transport failures: 0 / 0 / 1,306 / 297,104. Identical bundles still produced materially different highly-concurrent delivery/latency between controls: report local variation rather than treating a single nearby rate as universal. The second C repeat must use unchanged C and fresh persistence.

### C repeat 2 and promotion decision

[Repeat 2 final](../../bench/write-path/results/2026-10-11T22-04-33-078Z-9cf5a858/final.json) identifies `4010c8f`. **Both Worker bundle digests exactly match C repeat 1**; no C correction or workload/limit change was introduced between repeats. The order was B1 control 1 → C repeat 1 → B1 control 2 → C repeat 2, with fresh storage in all four matrices. Unrelated worktree files are recorded in manifests but are not bundled SUT inputs.

| Facts/call × concurrency | C repeat 2 acknowledged facts | Unknown calls | Acknowledged facts/s | Rate change vs B1 control 2 | Logical p95 (s) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 × 10 | 92,700 | 73 | 1,090.08 | −16.00% | 6.13 |
| 10 × 100 | 87,160 | 1,284 | 470.69 | −0.80% | 7.95 |
| 10 × 1,000 | 20,460 | 7,954 | 117.43 | +132.76% | 28.39 |
| 2 × 10,000 | 14,088 | 42,956 | 47.42 | +374.45% | 70.10 |

All planned calls were attempted; persisted facts matched acknowledgements; all admitted-write/index/transaction/restart checks passed, with no reconciled unacknowledged commits or unresolved decisions. Attempts: 1,924 / 37,732 / 73,399 / 376,486. Busy responses: 997 / 29,016 / 71,301 / 181,575. Transport failures: 0 / 0 / 52 / 187,867. Combined ledger SQLite bytes: 46,198,784 / 41,828,352 / 9,986,048 / 8,949,760. This repeat likewise observed no extra caller-unknown commits completed by recovery; fault-test recovery evidence is separate.

**Decision: do not promote C.** Neither repeat achieved 100% delivery in any scenario. Both nearby pairs show a medium-batch acknowledged-rate regression, a small-batch rate decrease, and substantially greater high-concurrency/saturation partial delivery and acknowledged rates. Small-batch delivery improved only in repeat 2; high-concurrency p95 differed in direction between pairs. These are mixed measurements on incomplete local loads, not successful-load throughput winners, universal correctness, or cloud capacity evidence. Preserve C and all four finals; **D starts from unchanged B1**, not from pooled ledgers. A is restored as the default outside explicitly selected tests/trials. The C experiment is complete under the evaluation contract, not successful under the promotion contract.

## D protocol: entity conflicts with a quiescent vector read fence

D starts from an independent **B1 copy**, not C. It retains per-transaction coordinator DOs, sixteen colocated fact/index/projection owner trees, payload-bound identity, deterministic owner acquisition, durable decisions, keys-only commit/cancel, and acknowledgement only after all apply/publication. It does not import pooled ledgers or their maintenance policy. New schema/routing identities and fresh persistence are mandatory. This section specifies the protocol before implementation/load evidence; it is not a correctness claim.

**Conflict ownership.** An owner durably reserves the complete set of entity URIs touched by that transaction, in one local SQLite transaction. Entity scope deliberately includes all fields, retractions, full entity projections, EA rows and AV rows. Different entities sharing a leaf or `(field, value)` index prefix may proceed: their concrete fact/value/index records include entity/fact identity, and SQLite applies each participant atomically. Do not infer independence solely from different fact IDs or fields on the same entity. The reservation binds transaction ID, payload hash, exact entity set, directory epoch, and a stable owner write ticket; replay cannot change any of these. Check routing after awaited key computation and again at reservation. Any overlap, active read lease, or pending owner topology change fails bounded admission; no lock wait/deadlock or alternate input queue is introduced.

All D writes, including one-owner writes, use the existing B1 distributed state machine and participant staging. B1's one-owner local protocol depends on a transaction-lifetime owner gate; keeping that shortcut would silently serialize most two-fact calls. Disable that internal path in D rather than leaving an alternate coarse writer alongside fine-grained writers. This necessary protocol unification is part of D's experiment, not the E atomic-commit optimization. One per-transaction coordinator owns the irreversible decision; owner reservations are conflict/publication witnesses, not independent decisions.

**Ordering.** Each owner allocates a unique, monotonically increasing ticket from a durable counter when its entity set is first reserved. Tickets are never reused; failed/unadmitted attempts may leave gaps. Different owners have independent sequence spaces. Persist each participant's owning ticket in the prepare plan, use that ticket for its fact/version rows and commit message, and publish it only at that owner. The receipt's compatibility scalar is the maximum ticket in the transaction, not a graph token or total order. An owner watermark advances by `max(previous, published ticket)`; out-of-order completion cannot lower it. Same-entity writes cannot apply out of ticket order because their reservation survives until publication or full cancellation. Do not allocate a graph-wide sequence or bind unrelated owner counters together.

**Atomic visibility/phantoms.** A read can acquire an owner lease only when that owner has **no entity reservations** and no topology operation. An acquired lease prevents new owner reservations. Whole-graph query acquires all sixteen bounded owner leases and scans at their published-watermark vector, retaining existing query/directory/fanout limits. If any owner is still writing or a lease expires, fail closed and release the partial cut. A high completed ticket must not expose a lower-ticket partial transaction: no scan is served while any owner reservation remains, even for unrelated entities. This is a deliberately conservative read fence, not FokosDB's explicit-key double-validation and not a phantom-unsafe index scan. Disjoint writes may finish while another write is held; reads may still return busy. No historical/vector-token client API is added.

**Recovery/publication/topology.** Keep entity reservations through prepare, durable commit decision, and required participant apply. After all applies, publish each owner and atomically release only that transaction's entity set. Repeating a published owner is idempotent even if other disjoint writes have since completed. Partial publication remains graph-read fenced by the remaining owners. Cancellation releases keys only after all required participant cancellations; commit decisions never become aborts. A split cannot start while any owner entity reservation or live read lease exists; an admitted split blocks new reservations. A persisted prepare plan must retain the same epoch/generation and entity ownership after restart; it cannot silently reroute pending writes. Recovery remains B1's durable caller-driven protocol, not C's alarms.

**Capacity/admission.** The existing 8-GB accounted ceiling, 6,250-outcome owner allocations / 100,000 graph allowance, seven-day identity window, SQL-binding pages, fact/byte/participant bounds and query limits stay fixed. Count active owner reservations as well as terminal ones before admission so concurrent preparation cannot overbook its allocation. Account entity-lock metadata growth. At leaves, multiple prepared disjoint writes require durable estimated mutation-growth reservations: include all prepared growth in admission/preflight and release that estimate atomically with commit/cancel. Counting only current staged SQLite bytes would allow accepted decisions to exceed the existing capacity bound. This is conservative accounting, not extra capacity or fact deletion.

**Verification before load.** Exercise held same-leaf disjoint writers (including shared AV prefixes), same-entity/different-field rejection, out-of-order ticket completion with fail-closed reads, partial prepare/apply/publication, aborted reservations, lost responses and eviction, complete projections/index membership, reserved capacity, split fencing/recovery and expired leases. The read-only owner audit must additionally reject leaked entity locks and inconsistent tickets; the leaf audit must reject prepared-growth reservations on terminal outcomes. Preserve the fixed workload and four fresh matrices in B1 → D → B1 → D order; apply the unchanged full-delivery promotion gate. Controlled gates and measured results below qualify the exercised protocol; they are not universal correctness certification.

D prototype checkpoint: an independent B1 copy exists under `poneglyph/src/storage-d/`, with entity reservation storage, per-owner tickets in participant plans, conservative vector read/split fences, prepared-growth accounting, and stronger read-only audit checks wired in. Schema version 4 / routing version 5 reject other implementations' persistence. Default A remains selected; its 41-test check (18 explicit skips), package build and seven harness tests passed after this prototype was added. These checks only establish that the isolated prototype does not regress A/composition; D controlled integration/fault tests were outstanding at this prototype checkpoint; their subsequent results are recorded below. All measured D trials were still outstanding. The disabled coarse local entrypoint cannot be used as a delivery fallback.

### D pre-load protocol gate

Explicit D selection passed **34 tests** across shared client/fact/Datalog and **12 D-controlled tests**, typecheck, package build and all **seven harness tests**. Same-leaf entities sharing the same AV prefix progress while a lower ticket is held; a same-entity/different-field mutation remains busy. Reads/splits remain fenced during that hold, and later completion of the lower ticket does not decrease visibility. A cross-owner transaction records distinct owner tickets, not a fabricated global sequence. Partial prepare, apply and publication recover after actual DO eviction; repeating publication preserves a later owner write. Cancellation/retraction, discarded response replay, interrupted split recovery, expired leases, exact entity-set binding and schema rejection are exercised. Synthetic accounted pressure verifies that one prepared participant's future growth prevents overadmitting another and that replay does not reserve twice; it is not physical capacity/performance evidence.

A missing-lock corruption fixture exposed a fail-closed requirement: consult pending reservation headers **as well as entity-lock rows** before issuing reads or starting topology work. The D guard now does both; the read-only audit detects inconsistent membership. The test's manual restoration is explicitly fixture cleanup, not a product repair path. This correction occurred before any measured D trial. Initial eviction fixture failures were fixed by draining an unread RPC response, which retained an active DO reference; no SUT timeout or benchmark retry setting changed. Append-only multi-value facts are counted as statements, not assumed to overwrite earlier values.

After restoring default A, its complete check passed **41 tests / 30 explicit skips** (five B1-only, twelve C-only, twelve D-only, one historical benchmark), package build and seven harness tests. A-specific coordinator/global-sequence/schema fixtures remain an A gate, not D evidence. No load ran concurrently with tests; no D promotion or complete-delivery claim is made before the four source-identified comparison matrices.

### Matched D comparison: first B1 control

[Control 1 final](../../bench/write-path/results/2026-10-11T22-49-05-774Z-35078d69/final.json) identifies selected B1 revision `a5c70a3`. Application and database bundles exactly match the earlier B1 controls; the new D source is not bundled into this control. All planned calls were attempted, all admitted-write/index/transaction/restart audits passed, and no extra unacknowledged commits were reconciled. No scenario completed full delivery.

| Facts/call × concurrency | B1 D-control 1 acknowledged facts | Unknown calls | Acknowledged facts/s | Logical p95 (s) |
| --- | ---: | ---: | ---: | ---: |
| 100 × 10 | 96,900 | 31 | 1,347.34 | 3.65 |
| 10 × 100 | 85,130 | 1,487 | 435.10 | 7.79 |
| 10 × 1,000 | 13,120 | 8,688 | 89.12 | 18.25 |
| 2 × 10,000 | 5,146 | 47,427 | 15.57 | 73.59 |

Attempts: 2,457 / 40,434 / 76,302 / 391,535. Busy responses: 1,488 / 31,921 / 74,959 / 128,270. Transport failures: 0 / 0 / 31 / 260,692. Recorded untracked video files are unrelated work, not bundled sources or experiment changes. Continue the planned B1 → D → B1 → D order with unchanged D and fresh persistence; this control is not a D result, cloud claim or promotion.

### D repeat 1: full delivery in two cases, no promotion

[Repeat 1 final](../../bench/write-path/results/2026-10-11T23-07-35-051Z-bfaf2f2a/final.json) identifies `D-narrower-conflict-locks` at selected revision `7efbcbd` (prototype `0a1ec6c`, pre-load fail-closed correction/tests `54dc846`). The tracked SUT was frozen during the run; unrelated video files are recorded but not bundled. No workload, caller retry, storage/query/transaction limit, or client behavior changed.

| Facts/call × concurrency | D repeat 1 acknowledged facts | Unknown calls | Acknowledged facts/s | Rate change vs nearby B1 control 1 | Logical p95 (s) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 × 10 | **100,000** | 0 | 1,532.62 | +13.75% | 1.26 |
| 10 × 100 | **100,000** | 0 | 541.70 | +24.50% | 4.43 |
| 10 × 1,000 | 99,580 | 42 | 473.26 | +431.05% | 46.38 |
| 2 × 10,000 | 49,384 | 25,308 | 167.07 | +973.17% | 76.77 |

Every planned call was attempted. Acknowledged facts exactly matched persisted facts; hot and restart fact/index/transaction/owner-ticket audits passed, with no leaked entity locks, unresolved decisions or reconciled unacknowledged commits. **The first two scenarios delivered their full 100k input**, unlike their nearby incumbent controls. The last two were incomplete; do not call their acknowledged rates successful-load throughput. Their logical p95 increased against the nearby B1 control despite greater delivery. Only a first local pair is available, not a repeatability or cloud claim.

Attempts: 1,717 / 20,468 / 27,938 / 310,958. Busy responses: 717 / 10,468 / 8,438 / 21,105. Transport failures: 0 / 0 / 9,542 / 265,161. All final caller failures were unknown after the unchanged retry budget. In particular the 1,000-call case's 42 exhausted calls and the saturation case's transport failures cannot be treated as delivered input. D still uses per-transaction DOs, whose physical metadata bytes are not fully aggregated; no storage-cost win is measured. Fault-test recovery is separate from this repeat, which observed no extra unknown commits recovered in the background.

**No promotion:** repeat 1 fails the required 100% delivery gate in all four scenarios. B1 control 2 and unchanged D repeat 2 are retained below; D remains isolated and ineligible. B1 is still the experimental incumbent. A is restored outside explicit tests/trials.

### Matched D comparison: second B1 control

[Control 2 final](../../bench/write-path/results/2026-10-11T23-29-04-964Z-7ec0666d/final.json) identifies `09fbb45`. Both Worker bundle digests exactly match D's first B1 control. Every planned call was attempted; all admitted-write and restart audits passed without reconciled extra commits. All four loads remained incomplete.

| Facts/call × concurrency | B1 D-control 2 acknowledged facts | Unknown calls | Acknowledged facts/s | Logical p95 (s) |
| --- | ---: | ---: | ---: | ---: |
| 100 × 10 | 96,900 | 31 | 1,573.40 | 3.15 |
| 10 × 100 | 86,830 | 1,317 | 488.93 | 7.57 |
| 10 × 1,000 | 12,800 | 8,720 | 86.06 | 18.44 |
| 2 × 10,000 | 5,018 | 47,491 | 15.23 | 72.32 |

Attempts: 2,391 / 39,275 / 76,282 / 391,491. Busy responses: 1,422 / 30,592 / 74,971 / 125,293. Transport failures: 0 / 0 / 31 / 263,689. Delivery/rates/latency and transport variance remain separate; identical bundles do not imply identical local performance. Continue with unchanged D repeat 2 and fresh persistence, not a retrospective substitution of an earlier incumbent run.

### D repeat 2 and promotion decision

[Repeat 2 final](../../bench/write-path/results/2026-10-11T23-46-28-059Z-71e7d580/final.json) identifies `60e42b9`. Both Worker bundle digests exactly match D repeat 1. The complete fresh-persistence order is B1 control 1 → D repeat 1 → B1 control 2 → D repeat 2. No measured SUT was patched and no correction, workload/limit/client change was introduced between D repeats.

| Facts/call × concurrency | D repeat 2 acknowledged facts | Unknown calls | Acknowledged facts/s | Rate change vs nearby B1 control 2 | Logical p95 (s) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 × 10 | **100,000** | 0 | 1,636.56 | +4.01% | 1.11 |
| 10 × 100 | **100,000** | 0 | 636.93 | +30.27% | 3.52 |
| 10 × 1,000 | 99,930 | 7 | 600.07 | +597.25% | 35.98 |
| 2 × 10,000 | 53,758 | 23,121 | 183.07 | +1,102.13% | 80.80 |

All planned calls were attempted. Acknowledged facts equalled persisted facts; admitted-write/index/owner-ticket/transaction audits passed hot and after restart, without leaked entity locks, unresolved decisions or reconciled unknown commits. Attempts: 1,711 / 20,430 / 24,369 / 298,488. Busy responses: 711 / 10,430 / 8,489 / 27,867. Transport failures: 0 / 0 / 5,887 / 243,742. The remaining seven exhausted calls at concurrency 1,000 and 23,121 at saturation are not delivered input.

**Decision: do not promote D.** D repeatably completed the medium and small cases, substantially improved partial delivery at high concurrency/saturation, and reduced their busy responses. However **both repeats failed full delivery in the other two cases**, so the immutable all-four promotion gate fails. High-concurrency/saturation logical p95 was higher than the nearby incumbent in both pairs, even with much greater delivery; caller latency and transport failures cannot be hidden behind an acknowledged rate. Incumbent controls remain incomplete, so percentages are descriptive local acknowledged-rate comparisons, not an equal-success throughput certification. No cloud, universal correctness, physical-storage cost or 1M claim follows.

Preserve D's independent source, exercised protocol tests, all four finals and input/source/client identities. **E starts from unchanged B1**, not D or C. A is restored outside explicitly selected tests/trials. D's evaluation task is complete, while its promotion contract is not satisfied; no additional automatic retry, delivery queue or transport-limit increase is permitted to turn this result into a winner.

## E protocol: payload-bound atomic leaf authority

E is an independent **B1 copy**, not D or C. It retains graph-scoped per-transaction identity binding, sixteen owner gates, leased vector reads, the existing capacity/retention/fact/query limits and the ordinary awaited client path. Its optimization is eligible only when an existing owner transaction resolves to **one physical leaf** containing every required fact, EA/AV index and entity projection mutation. One owner tree with multiple leaf participants still uses the unchanged distributed protocol. Caller-provided tokens remain eligible: do not copy FokosDB's tokenless single-shot shortcut.

**Authority and delegation.** The graph-wide transaction DO binds `(graph, txId, canonical payload hash)` before forwarding a one-tree batch. The existing owner coordinator persists its intent, exact leaf prefix/generation, directory epoch, statement time and sequence while reserving its B1 owner gate. Before making any atomic RPC, persist a distinct **delegated** phase. This irrevocably selects that leaf as the decision authority for this admitted operation; it is not itself a commit decision. A delegated operation must never fall back to prepare/commit/cancel, reroute to another leaf, or infer abort from a timeout/non-authoritative error. The local leaf's atomic terminal record is the only commit/abort decision. The owner and graph-level records thereafter record recovery/publication witnesses, not competing decisions.

**Local transaction.** A bounded `_atomic` message carries the same trusted participant facts, caller ID/hash, owner sequence, statement time and fenced route. The leaf verifies its current writable identity and durable replay outcome, then executes validation/capacity admission, append-only fact rows, all active-fact/value indices, complete entity projections and the terminal committed outcome in **one SQLite transaction**. A crash/exception between fact application and outcome insertion rolls back all of them. No externally visible prepare record or separate commit message is needed for this eligible path. Retained same-ID/hash replay returns the prior outcome before mutable fact validation or new capacity reservation. Changed payload conflicts; an existing distributed prepared record is not silently converted into an atomic operation.

Validation/capacity failures at the correct active leaf may record an atomic **aborted** outcome, with a retained rejection classification, without applying any facts. Malformed envelopes, stale ownership/generation, unknown transport results or other non-authoritative failures are not proof of local abort. They leave durable delegation pending for replay at the same fenced authority. Unexpected application failures roll back and remain recoverable; they must not become cancelled outcomes merely because an exception occurred after a write statement. Atomic outcomes carry their kind/sequence/expected fact count so read-only checks can verify full local membership and distinguish them from distributed staging.

**Publication and acknowledgement.** After a confirmed local committed outcome, the owner atomically completes its delegated publication witness, advances visibility and releases its existing owner gate; only then may the graph-level receipt complete and the awaited application call succeed. After a confirmed local aborted outcome, retain the owner/global aborted binding and release the gate without publishing. Never acknowledge a persisted delegation, queued RPC, applied-but-unpublished fact set, or terminal maintenance work. The compatible receipt scalar retains B1's sequence scope; no new public snapshot token API is introduced. TODO notifications remain best-effort after commit, without an outbox.

**Recovery/migration.** A lost leaf answer leaves the owner in delegated phase; recovery reads the durable batch/route and repeats the idempotent atomic message. A lost owner/graph answer replays retained publication/global receipts. The gate prohibits splitting/moving an unfinished delegation, including after eviction; the leaf still checks current generation before any new mutation. Once completed, normal splitting may move fact/index/projection rows while the stable owner/global receipts answer retries without reappending to a child. Terminal leaf outcomes may remain on the old routed object during the identity window; do not mistake a retired router's migrated-out fact rows for missing active-leaf membership. No unfinished delegation or decision expires at seven days, and terminal record sweeping never removes source facts. In particular, a locally terminal atomic outcome remains **pinned until owner publication/abort is confirmed**; terminal status alone does not mean global delegation has finished. After publication, the owner sends an idempotent finalization notice. Failure of this post-publication cleanup must not change a committed acknowledgement into failure. Bounded leaf maintenance (at most 100 records per sweep) can confirm publication through a read-only stable-owner proof and unpin/sweep eligible outcomes, without driving alternate input or inventing decisions. Matching owner intent must be terminal; a newer same-ID intent (distinguished by its monotonic statement time/sequence/hash) proves the older one finished, because unfinished intents cannot be replaced. If the old intent was terminally pruned, the existing owner-gate invariant can prove release; ambiguous active ownership remains pinned. This avoids expiring a lost-response local authority before recovery and avoids an unbounded abandoned-pin leak. Seven days remains the deduplication setting; unfinished publication is not eligible for expiry. Fresh E schema/routing identity is mandatory; no in-place reinterpretation or request-time backend selection is allowed.

**Pre-load verification.** Exercise one SQLite rollback after fact/projection application but before terminal outcome; correct and changed-payload replay under capacity pressure; authoritative validation abort; lost local answer after commit, owner/global answer loss and actual eviction; fail-closed reads and split rejection while delegated; stale generation refusal without invented abort; replay after completed migration; a multi-leaf owner batch retaining the distributed path; complete index/projection/outcome membership and immutable identity sets. Then obtain the unchanged fresh B1 → E → B1 → E matrices. Full delivery in all four scenarios in both repeats remains mandatory for promotion. The implementation checkpoint below records controlled evidence; no measured E matrix is claimed yet.

### E implementation and controlled gate

The independent `storage-e/` copy adds the delegated owner phase and atomic SQLite leaf authority, using schema **5** (`e-coordinator` / `e-shard`) and routing **6**. The leaf hashes the complete ordered batch, checks current writable generation, replays retained terminal outcomes before mutable validation/capacity, and commits all fact/index/projection rows together with its outcome. Correct-owner validation/admission aborts are durable; application exceptions roll back without inventing a decision. Owner recovery revalidates its writer/epoch/sequence/topology fence before RPC and refuses physical participant changes. One-owner, multiple-leaf transactions retain distributed staging.

Local committed and aborted outcomes remain pinned until owner publication is confirmed. Post-publication finalization failure is logged without reversing acknowledgement. Indexed local maintenance verifies stable-owner release using at most **100 total proof/expiry records per alarm and six concurrent proof requests**, then reschedules; it does not complete delegated writes or process alternate input. Source facts are never swept; retired routers preserve atomic outcomes while retaining stable owner/global receipt replay. Projection pruning remains post-publication best effort, matching the acknowledged-commit safety correction.

`tests/e-atomic.test.ts` exercises **14 cases**: all mutations/outcome together without prepare/commit calls; injected exception after complete application rolls back; lost local answer and actual eviction; disjoint-owner progress with busy whole-graph reads/split rejection; pending commit **and abort** authority survive synthetic expiry; finalization failure followed by proof/terminal cleanup; authoritative invalid-retraction abort; global receipt replay after migration; multi-leaf distributed path; retained retraction replay under synthetic accounted pressure; stale-generation refusal without invented abort; lost owner publication answer before global receipt; 100-record cleanup bounds; B1 persistence rejection. Synthetic expiry/accounting/bounds fixtures are not physical-capacity, delivery or performance measurements. Caller IDs remain graph-wide payload bound and changed-owner payloads conflict.

The abort-recovery test found an inherited private-owner replay classification issue: same-payload terminal abort returned 409, leaving the graph driver's intent nonterminal. E classifies that authoritative abort as **422**, matching the normal public abort outcome, while changed payload remains 409; tests verify graph records finish `aborted`/`complete`. No A/B1/C/D source or client behavior changed. With E explicitly selected, **36 tests** passed across E/client/fact-model/Datalog, typecheck/package and all **7 harness tests** passed. These certify only exercised invariants, not A-specific global ordering/schema fixtures or universal correctness. No E load has run; promotion still requires both unchanged fresh matrices and nearby B1 controls.

### Matched E comparison: first B1 control

[Control 1 final](../../bench/write-path/results/2026-10-12T00-36-54-973Z-94051e91/final.json) identifies `d6c085f`. It starts the fresh B1 → E → B1 → E sequence. All planned calls were attempted; admitted-write/index/transaction/restart audits passed, with no reconciled extra commits. All four loads remained incomplete.

| Facts/call × concurrency | B1 E-control 1 acknowledged facts | Unknown calls | Acknowledged facts/s | Logical p95 (s) |
| --- | ---: | ---: | ---: | ---: |
| 100 × 10 | 97,200 | 28 | 1,553.12 | 3.03 |
| 10 × 100 | 85,370 | 1,463 | 463.31 | 7.51 |
| 10 × 1,000 | 12,930 | 8,707 | 88.46 | 17.94 |
| 2 × 10,000 | 5,104 | 47,448 | 15.37 | 74.50 |

Attempts: 2,434 / 40,030 / 76,465 / 391,682. Busy responses: 1,462 / 31,493 / 75,172 / 124,944. Transport failures: 0 / 0 / 0 / 264,186. These are incumbent admitted-rate measurements, not successful-load, E or cloud claims. E repeat 1 follows below.

### E repeat 1: incomplete delivery, mixed admitted rates

[Repeat 1 final](../../bench/write-path/results/2026-10-12T00-54-16-107Z-34414cc8/final.json) identifies `ed69538` / `E-idempotent-local-commit`, implementation `7fd8d73`. The SUT stayed frozen with unchanged client, caller/workload/limit settings. Every planned call was attempted; acknowledged facts exactly matched persisted facts, and all admitted-write/index/transaction/atomic-membership/restart audits passed without unresolved decisions or reconciled extra commits.

| Facts/call × concurrency | E repeat 1 acknowledged facts | Unknown calls | Acknowledged facts/s | Rate change vs nearby B1 control 1 | Logical p95 (s) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 × 10 | 97,100 | 29 | 1,420.95 | −8.51% | 3.69 |
| 10 × 100 | 86,810 | 1,319 | 492.29 | +6.26% | 7.48 |
| 10 × 1,000 | 13,150 | 8,685 | 90.24 | +2.01% | 18.20 |
| 2 × 10,000 | 4,892 | 47,554 | 14.57 | −5.23% | 75.73 |

Attempts: 2,374 / 39,012 / 76,155 / 391,682. Busy responses: 1,403 / 30,331 / 74,801 / 123,366. Transport failures: 0 / 0 / 39 / 265,870. All four workloads remained incomplete. **No promotion:** the mandatory delivery gate fails in this repeat. Mixed partial acknowledged-rate changes do not certify successful-load throughput or repeatability. B1's coarse owner conflict/visibility rules and per-ID placement remain intact; atomic local mutation is not proof those bottlenecks disappeared. Physical per-ID metadata bytes and cloud behavior remain unmeasured. The second fresh B1/E pair with unchanged E is retained below.

### Matched E comparison: second B1 control

[Control 2 final](../../bench/write-path/results/2026-10-12T01-12-49-018Z-a98c4096/final.json) identifies `47cf04d`. Both Worker bundles exactly match E control 1. All planned calls were attempted; admitted-write/restart audits passed without extra unknown commits. All loads remained incomplete.

| Facts/call × concurrency | B1 E-control 2 acknowledged facts | Unknown calls | Acknowledged facts/s | Logical p95 (s) |
| --- | ---: | ---: | ---: | ---: |
| 100 × 10 | 96,800 | 32 | 1,505.24 | 3.18 |
| 10 × 100 | 85,910 | 1,409 | 460.14 | 7.69 |
| 10 × 1,000 | 12,560 | 8,744 | 77.59 | 20.14 |
| 2 × 10,000 | 4,688 | 47,656 | 14.56 | 70.41 |

Attempts: 2,364 / 40,022 / 76,235 / 392,167. Busy responses: 1,396 / 31,431 / 74,947 / 121,218. Transport failures: 0 / 0 / 32 / 268,605. Identical-bundle variation remains visible. Unchanged E repeat 2 with fresh persistence follows below.

### E repeat 2 and promotion decision

[Repeat 2 final](../../bench/write-path/results/2026-10-12T01-31-18-399Z-482b2d6f/final.json) identifies `7cf5b67`. Both Worker bundles exactly match E repeat 1. The complete fresh order is B1 control 1 → E repeat 1 → B1 control 2 → E repeat 2. No implementation, client, workload, limits or caller retry behavior changed between repeats.

| Facts/call × concurrency | E repeat 2 acknowledged facts | Unknown calls | Acknowledged facts/s | Rate change vs nearby B1 control 2 | Logical p95 (s) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 × 10 | 97,100 | 29 | 1,543.08 | +2.51% | 3.68 |
| 10 × 100 | 86,920 | 1,308 | 490.86 | +6.68% | 7.46 |
| 10 × 1,000 | 12,810 | 8,719 | 83.81 | +8.02% | 18.81 |
| 2 × 10,000 | 4,672 | 47,664 | 14.26 | −2.08% | 72.19 |

Every planned call was attempted; acknowledged facts equalled persisted facts, with valid admitted-write/index/atomic-membership/transaction/restart audits, no unresolved decisions and zero reconciled unknown commits. Attempts: 2,390 / 39,279 / 76,348 / 391,999. Busy responses: 1,419 / 30,587 / 75,067 / 118,822. Transport failures: 0 / 0 / 0 / 270,841. All four loads were incomplete in both E repeats.

**Decision: do not promote E.** Small/high acknowledged rates were higher than their nearby B1 controls in both pairs; medium direction differed, and saturation rates/delivery were lower in both. Small logical p95 was slightly lower, medium/saturation higher, and high-concurrency p95 direction differed between pairs. These are partial-load local descriptions with identical-bundle incumbent variation, not equal-success throughput or evidence that atomic local commits resolve coarse owner contention/per-ID lifecycle overhead. Controlled rollback/replay/authority recovery is separate from measured matrices, which observed no extra unknown commits recovered. Physical per-ID bytes/cost and cloud performance remain unmeasured. Full-delivery promotion fails in **every scenario in both repeats**.

Preserve E's independent source, controlled tests, both repeats/nearby controls and all source/input/client identities. **F starts from unchanged B1**, not E, D or C. A is restored as default outside explicit trials. E's evaluation is complete, not successful promotion; no caller-limit/workload/retry change, additional input queue, cloud execution or default cutover follows.

## F protocol: provisional plans and referenced owner staging

F is an independent B1 copy. It does **not** combine C/D/E. Preserve B1's coarse owner gates, vector visibility, per-ID decision authority and all fixed limits/retention/client/input settings. Optimize redundant work, not correctness obligations or input admission.

**Cross-owner planning outside gates.** Obtain read-only owner directory epochs/visible sequences, compute fact hashes/routes and group participants, then run read-only capacity preflight before taking owner gates. These are provisional observations, not prepared intents or admission. Acquire the same deterministic owner gates; compare each locked directory epoch against its provisional epoch before any participant mutation. A mismatch releases only this transaction's unprepared gates, clears its unadmitted intent and returns a retryable routing conflict. Do not patch/reuse a stale leaf plan. Persist the final plan and sequence only after matching gates. Leaf prepare still verifies writable prefix/generation and current capacity/validation, so cached positive preflight is never sufficient authority. If owner visibility changed after a provisional rejection, repeat the rejection's preflight under the gate rather than preserving an obsolete failure. Once a prepare plan is durable, restart retains exact routes/gates; do not silently reroute an admitted transaction.

**Single-owner redundant stage.** The graph-wide per-ID journal already durably stores the canonical batch before calling the owner. An owner verifies that binding with a read-only journal metadata lookup before reservation; its local intent can then persist a bounded **journal reference**, exact participant routes, sequence/time/epoch and its unchanged decision phase instead of another full batch JSON blob. The journal retains unfinished records indefinitely. Cold owner recovery resolves the reference at the stable graph/tx-ID route, verifies graph/id/hash and canonical batch, and reconstructs only its pinned participants. Missing/mismatching journal or topology is a recoverable fail-closed error, never permission to mutate/reroute/abort an irrevocable decision. The public path still awaits the same required prepare/apply/publication; the journal endpoint is internal read-only recovery, not an import or delivery fallback. No C pooled routing or E delegated leaf authority is introduced.

**Hot rereads.** A freshly admitted single-owner drive can reuse its already parsed/bound batch and grouped immutable participant plan instead of rereading, parsing, hashing and regrouping the just-written owner intent. Revalidate its owner/epoch/sequence/topology fence before prepare. A leaf may retain a bounded typed cache for its one outstanding coarse-owner prepared batch and avoid decoding that same staged JSON at hot commit. Durable participant status/hash/route checks remain authoritative; after eviction, use the unchanged durable leaf payload. Clear caches on terminal commit/cancel and never use them as decisions or capacity authority. Do not remove the leaf recovery payload or the graph journal merely because a hot cache exists.

**No visibility/capacity shortcut.** Prepare and commit still apply every fact, EA/AV index and projection, followed by all owner publications before receipt. Outdated readonly observations are not mutation validation. Splits/live read leases still exclude owner writes; partial apply/publication remains query fenced. Capacity and outcome allocation remain the incumbent's limits, with actual participant admission checked synchronously before staging. Fact retention is unchanged; journal/terminal cleanup cannot remove facts or expire unfinished decisions.

**Required gates.** Hold provisional planning/preflight and prove owner gates remain available to unrelated work; split between plan and lock and verify rejection before staging; update visibility/capacity between preflight and admission; partial prepare/apply/publication, exact-route recovery, lost receipt and changed payload; actual owner eviction with referenced batch recovery; actual leaf eviction with cache miss; complete indices/projections and metadata-only staging; lease/topology fencing. Then fresh B1 → F → B1 → F matrices under the unchanged all-four full-delivery promotion gate. Identify removed work in code/tests rather than claiming shorter gates from synthetic accounting. The controlled implementation checkpoint below is available; no measured F result is claimed yet.

### F implementation and controlled gate

The independent `storage-f/` B1 copy uses schema **6** (`f-coordinator` / `f-shard`) and routing **7**. Cross-owner `_tree-plan`, entity-route grouping and provisional readonly preflight precede the deterministic gates. Locked epochs must match before saving a prepare plan; current leaf prepare still validates generation/facts/capacity. Changed visibility causes preflight rechecking. Recovery never recomputes an admitted route plan.

Single-owner reservations persist `batch_reference = 1`, `batch_json = NULL` plus hash/routes/sequence/time/epoch after a readonly graph-journal binding check. The existing stable per-ID journal remains the durable canonical batch; its internal GET endpoint is read-only and can serve a recovering owner while the graph driver awaits that owner. The fresh owner drive reuses grouped participants (one grouping, zero full journal recovery reads); a cold preparing owner verifies/resolves its exact journal reference. Terminal abort replay is correctly 422 so the graph-level aborted witness finalizes, as required by the recovered authority test in E; changed payload still conflicts. The owner metadata footprint no longer charges a removed local blob, without changing the fixed 8GB limit. This is code/accounting shape, not physical-storage savings evidence.

A single bounded hot leaf slot reuses the typed prepared batch only when its serialized payload exactly equals the durable row, after SQL status/hash and writable-route checks. It clears on commit/cancel. Cold leaves use the unchanged durable prepare JSON. No leaf recovery payload, index, projection, publication or durable decision was omitted. Code review also identified a retry edge: an interrupted unprepared-gate release can survive a prior attempt. Before deleting a failed provisional/lock intent, F releases **all originally involved owners by durable transaction identity**, not merely gates reacquired in the current attempt; other writers are untouched. A controlled test reproduces that interrupted-release/retry sequence and verifies no orphan gates.

`tests/f-planning.test.ts` has **17 controlled cases**: incumbent held/disjoint progress, overlap and fail-closed query; partial cross-owner apply; retraction cancellation/payload conflict; split resume; expired read lease; held provisional preflight with same-owner writes/reads still progressing; actual split between plan/lock and pre-staging rejection; actual owner/journal eviction with reference recovery; unavailable journal fail closed; exact hot owner grouping and hot leaf cache; actual cold-leaf eviction; partial prepare/publication without replanning; changed synthetic accounted capacity after positive provisional preflight; interrupted unprepared release/retry cleanup; B1 schema rejection. Synthetic accounted pressure is not physical capacity evidence. Identical-value query tuples deduplicate while append-only source facts remain distinct.

With F explicitly selected, **39 tests** passed across F/client/fact-model/Datalog, typecheck/package and all **7 harness tests** passed. A-specific global sequence/schema fixtures remain A gates, not F certification. No F matrix has run; preserve the controls/fresh-input/unchanged-SUT/all-four promotion contract. This proves exercised invariants and identifies removed work, not shorter measured gates, universal correctness, successful-load throughput or cloud performance.

### Matched F comparison: first B1 control

[Control 1 final](../../bench/write-path/results/2026-10-12T02-15-00-285Z-e24a464c/final.json) identifies `428e540`. It begins fresh B1 → F → B1 → F. Every planned call was attempted; admitted-write/index/transaction/restart audits passed without reconciled extra commits. All four loads remained incomplete.

| Facts/call × concurrency | B1 F-control 1 acknowledged facts | Unknown calls | Acknowledged facts/s | Logical p95 (s) |
| --- | ---: | ---: | ---: | ---: |
| 100 × 10 | 97,000 | 30 | 1,329.45 | 4.11 |
| 10 × 100 | 85,520 | 1,448 | 441.91 | 7.84 |
| 10 × 1,000 | 12,860 | 8,714 | 82.93 | 19.24 |
| 2 × 10,000 | 5,272 | 47,364 | 15.67 | 75.87 |

Attempts: 2,395 / 40,313 / 76,272 / 391,417. Busy responses: 1,425 / 31,761 / 74,980 / 130,752. Transport failures: 0 / 0 / 6 / 258,029. This is incumbent partial-load evidence, not F, cloud or promotion evidence. F repeat 1 follows below.

### F repeat 1: greater partial delivery, no promotion

[Repeat 1 final](../../bench/write-path/results/2026-10-12T02-33-52-343Z-a00ec2c3/final.json) identifies `cfcb98c` / `F-shorter-critical-sections`, implementation `6df5196`. The measured SUT/client/workload/limits/caller settings stayed frozen. Every planned call was attempted; acknowledgements equalled persisted facts. Admitted-write/index/transaction/restart audits passed with no unresolved decisions or reconciled extra commits.

| Facts/call × concurrency | F repeat 1 acknowledged facts | Unknown calls | Acknowledged facts/s | Rate change vs nearby B1 control 1 | Logical p95 (s) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 × 10 | 98,300 | 17 | 1,528.58 | +14.98% | 2.73 |
| 10 × 100 | 85,940 | 1,406 | 477.35 | +8.02% | 8.06 |
| 10 × 1,000 | 37,010 | 6,299 | 145.60 | +75.57% | 33.88 |
| 2 × 10,000 | 10,552 | 44,724 | 30.75 | +96.18% | 77.52 |

Attempts: 2,059 / 32,429 / 67,186 / 381,418. Busy responses: 1,076 / 23,835 / 63,182 / 95,868. Transport failures: 0 / 0 / 303 / 280,274. All workloads were incomplete: **no promotion**. All four acknowledged rates/partial delivery were higher than the nearby incumbent, but small/high/saturation logical p95 was higher, and high/saturation transport failures increased. More delivered facts and lower busy counts do not certify equal-success throughput, shorter measured gates, low overhead or cloud behavior. Gate removal and metadata/reference/cache invariants are controlled-code evidence; no gate-duration instrumentation or physical per-ID storage/cost comparison was added to the frozen workload. The second unchanged fresh B1/F pair is retained below.

### Matched F comparison: second B1 control

[Control 2 final](../../bench/write-path/results/2026-10-12T02-54-15-303Z-ba9568e6/final.json) identifies `f8ed048`. Both Worker bundles exactly match F control 1. Every planned call was attempted; admitted-write/restart audits passed without extra unknown commits. All loads remained incomplete.

| Facts/call × concurrency | B1 F-control 2 acknowledged facts | Unknown calls | Acknowledged facts/s | Logical p95 (s) |
| --- | ---: | ---: | ---: | ---: |
| 100 × 10 | 96,900 | 31 | 1,555.90 | 3.24 |
| 10 × 100 | 86,270 | 1,373 | 481.49 | 7.49 |
| 10 × 1,000 | 13,000 | 8,700 | 87.49 | 18.45 |
| 2 × 10,000 | 5,060 | 47,470 | 15.23 | 74.17 |

Attempts: 2,349 / 39,400 / 76,347 / 391,631. Busy responses: 1,380 / 30,773 / 75,016 / 130,324. Transport failures: 0 / 0 / 31 / 258,777. Nearby identical-bundle controls still vary; do not replace them with an older favorable run. Unchanged F repeat 2 with fresh persistence follows below.

### F repeat 2 and promotion decision

[Repeat 2 final](../../bench/write-path/results/2026-10-12T03-11-29-100Z-2fd794c1/final.json) identifies `7529e1f`. Both Worker bundles exactly match F repeat 1. The complete fresh order is B1 control 1 → F repeat 1 → B1 control 2 → F repeat 2. No measured SUT, client, workload, limits or caller retry setting changed.

| Facts/call × concurrency | F repeat 2 acknowledged facts | Unknown calls | Acknowledged facts/s | Rate change vs nearby B1 control 2 | Logical p95 (s) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 × 10 | 98,300 | 17 | 1,617.19 | +3.94% | 2.84 |
| 10 × 100 | 86,340 | 1,366 | 508.01 | +5.51% | 7.96 |
| 10 × 1,000 | 37,150 | 6,285 | 149.97 | +71.42% | 33.42 |
| 2 × 10,000 | 10,722 | 44,639 | 32.19 | +111.34% | 73.72 |

Every planned call was attempted; acknowledged facts equalled persisted facts, all admitted-write/index/transaction/restart audits passed, no unresolved decisions remained and no unknown commits were reconciled. Attempts: 2,036 / 31,664 / 66,939 / 381,182. Busy responses: 1,053 / 23,030 / 62,942 / 95,868. Transport failures: 0 / 0 / 282 / 279,953. All four loads remained incomplete.

**Decision: do not promote F.** Its local partial acknowledged rates/delivery increased against nearby B1 controls in all four scenarios in both pairs, with fewer busy responses. Medium p95 decreased, small/high p95 increased in both pairs; saturation p95 direction differed. High/saturation transport failures were higher in both pairs. Preserve those tradeoffs and identical-bundle incumbent variation, without claiming equal-success throughput, measured gate durations, cold-start/lifecycle efficiency, physical bytes/cost or cloud performance. Controlled evidence establishes removed owner staging/hot rereads and routing/recovery invariants; no additional queued input or retry/limit change was used to deliver the missing calls. **All-four full-delivery promotion fails in both repeats.**

Preserve F's independent source/tests and both repeat/control finals with their source/input/client identities. **B1 stays incumbent**; A is restored as default outside explicit trials. F's evaluation is complete, not promotion. The requested independent C → D → E → F sequence is fully evaluated and may conclude even though no candidate qualified.

### Proposed G: combined integration experiment

The user proposed a subsequent G combining C's pooled recovery ledgers, D's entity conflicts/quiescent vector fence, E's payload-bound atomic authority and F's provisional planning/reduced work. This is a **separate integration experiment**, not a promotion of any losing independent candidate. Preserve C–F evaluations; specify interactions before implementing G, particularly out-of-order owner tickets, atomic decision delegation/publication pinning, pooled recovery and stale routing revalidation. Do not assume optimizations compose, import mixed runtime implementations, replace a nearby control or change the workload/limits/retries. G would require its own correctness gates, two fresh 100k matrices and repeated nearby incumbent controls under the same full-delivery rule. This was a proposal during the immutable C–F goal, not a G implementation/evaluation claim or default cutover. After completing that goal, the user confirmed the separate G goal `mv5798ar-prbz27`; its protocol is specified below.

## Confirmed G protocol: pooled recovery, entity tickets and atomic delegation

G is a fresh **B1-derived independent implementation**, integrating the reviewed deltas from C/D/E/F rather than importing their runtimes. A/B1/C/D/E/F, controlled tests and all finals remain unchanged. Use fresh schema **7** (`g-coordinator` / `g-shard`) and routing **8**, explicit source composition and a truthful G build identity. The previous C–F zero-promotion conclusion is unchanged; G must obtain its own gates and B1 → G → B1 → G evidence before any experimental promotion. The user subsequently amended this goal: correctness remains mandatory, but experimental promotion can precede full delivery when both pairs improve acknowledged/persisted delivery and acknowledged rate in all four scenarios (full-delivery ties allowed only when both fully deliver). Mixed latency/transport tradeoffs require user judgment. Continue independent improvements from the latest accepted incumbent until full delivery; experimental promotion is not full-delivery certification or default cutover. A remains default outside explicit trials.

### Durable truth and phases

Facts remain append-only durable truth; EA/AV indices and entity projections are complete derived state. Sixteen graph-scoped hash buckets own payload-bound caller identity, with stable graph/tx-ID routing and persisted bucket context. Each ledger record binds graph, ID, canonical batch hash and its retention anchor. Different IDs in a bucket interleave; only the same ID is execution-exclusive. SQL records, not engine maps/caches, are authoritative. The graph allocation remains 16 × 6,250 retained unfinished/terminal rows and the existing 8GB accounting, not unlimited accepted input.

The canonical batch is stored once at the identity ledger. Persisted plans contain fenced addresses/epochs, exact owner entity sets, owner tickets and batch indices/virtual keys, **not another full copy of the facts**. Validate indices/order/ownership when materializing participant messages from the journal. Hot typed batch/participant caches are bounded and optional; restart verifies the journal/hash and compact plan. Owners store reservations/ticket witnesses without a local batch blob. Distributed leaves retain their durable prepare payload; an exact-payload hot slot may avoid decoding it, with durable status/hash/generation checks first.

Use explicit phases: `planning` (identity journal, no owner mutation), `reserving` (durable provisional plan/entity sets before owner RPC), `preparing` (confirmed fenced owner reservations and durable final plan), `committing` (irrevocable distributed decision), `atomic-delegated` (irrevocable choice of one local decision authority, **not** a commit decision), `cancelling`, `complete`, `aborted`. Do not transition atomic delegation into distributed commit/cancel or replan an admitted operation. Any recovery path distinguishes authority decisions from intent and publication witnesses.

Planning/topology/contention failures with no participant mutation may release only this ID's owner reservations and delete its unadmitted intent, as in the earlier experiments. A partial/lost reservation answer is not proof of release: the `reserving` record persists exact involved owners, and recovery resolves/releases that set before completing an abort or deleting an unadmitted record. An alarm must not turn a stranded unadmitted provisional request into newly delivered facts: an interrupted `planning` journal may be terminally aborted without owner RPC because that phase guarantees no reservation/mutation was issued; recovery of interrupted `reserving` is cancellation/release, not fresh admission to missing owners. These are explicit recovery decisions, not time-based expiry of unfinished work. Once all reservations and the final `preparing` plan are durable, normal recovery may finish the already admitted operation. Never expire a nonterminal record to evade uncertainty.

### Provisional planning, conflicts and topology

Read-only owner directory snapshots, entity hashes/routes, grouping and capacity preflight precede entity reservation RPCs. They are provisional, not locks, prepared state or admission. Each owner atomically reserves the full sorted unique entity set, binds hash/identity context, and allocates a unique monotonic owner-local ticket. Same-entity fields/retractions/projections conflict; different entities may share a physical leaf or AV prefix because concrete rows are entity/fact qualified. Reservation admission checks expected directory epoch, active topology/read lease, exact ownership and existing outcome/capacity allocations. Missing or changed epochs reject before participant mutation; release every originally involved owner by this ID, including reservations stranded by an earlier interrupted release.

Persist tickets/epoch/generation and compact participant plan only after confirmation. Before every new mutation, leaf writable identity/generation and current capacity/fact validity still apply. Changed owner visibility may invalidate provisional rejection and requires rechecking; positive readonly preflight never replaces synchronous prepare/atomic admission. An admitted plan retains exact addresses, entities, tickets and epoch after restart and never silently reroutes. Splits exclude all pending owner reservations (not just lock-row counts) and live read leases; writes cannot enter an admitted split. Ticket gaps are retained rather than reused. Receipt scalar max remains compatibility metadata, not a global order or snapshot token.

### Distributed and atomic authorities

For multiple physical leaves, stage all required participant facts/indices/projections under the reserved owner tickets; participant growth accounting includes every already prepared future mutation. Only after all prepares are confirmed does the ledger persist `committing`. That ledger is the sole irrevocable decision authority. Recovery applies every participant, durably records an all-participants-applied witness **before** any owner publication, then publishes each owner ticket and releases its exact entity set; only after **all** apply/publication receipts may the graph-level receipt complete. Recovery after a lost publication answer uses that witness instead of recommitting a physical leaf which may already have migrated. Cancellation likewise durably records all participant cancellations before releasing owner fences, so release recovery does not require cancellation RPCs to retired leaves. Prepare failure selects durable cancellation; release occurs only after every staged participant's cancellation is confirmed. Irrevocable commit never becomes abort because of a missing response or cleanup failure.

For **one physical leaf containing the entire batch**, including caller-supplied IDs, persist `atomic-delegated` with the pinned owner reservation/ticket, generation/epoch and journal reference before sending `_atomic`. The leaf becomes the sole decision authority for that operation. It checks the complete ordered batch hash/owner/generation, then synchronously admits capacity including other transactions' reserved growth, validates and appends every fact/EA/AV/projection mutation **together with its committed outcome in one SQLite transaction**. A post-application exception rolls back the entire transaction, without inventing abort. Correct-owner validation/admission rejection may durably record local abort without any fact mutation; malformed/stale/transport/non-authoritative errors do not prove abort. A distributed prepared record cannot be converted to atomic work.

After local commitment, the ledger durably records the exact local terminal witness **before** issuing owner publication/release, then confirms that publication before completing the receipt. After local abort, durably record the local abort witness before release/cancellation of its exact reservation and terminal graph abort. Recovery with a durable local witness repeats publication/release, not the local mutation: the owner may already have released its fence and split/migrated the authority after a lost publication answer. Retained local decision replay validates its original authority tuple before mutable writable-role/generation checks; a new decision still requires the current writable leaf. A lost local answer repeats the same pinned authority message, never distributed fallback, retraction, rollback or rerouting. A lost owner/global answer replays its witnesses. Ticket-specific applied versions may finish out of order; atomicity is supplied by local SQLite plus the graph read fence, not by pretending tickets are a total commit order. Atomic admission must not consume storage promised to a different prepared same-leaf writer.

### Visibility, pins and retention proof

Owner publication advances `MAX(previous visible ticket, this ticket)`, but a whole-owner read lease is unavailable while **any** entity reservation is pending. Leases prevent new reservations; a graph query acquires all sixteen bounded owner leases and uses their own sequence/epoch vector. Busy/expired/topology cuts fail closed and release partial leases. Publication of ticket 6 while ticket 1 remains unfinished cannot expose a fractured query; neither high watermark nor absence of a coarse writer field proves ticket 1 finished.

**All participant terminal outcomes**, distributed as well as atomic, remain pinned until their exact owner publication/abort is confirmed. Otherwise a committed-but-unpublished distributed outcome could disappear after seven days while a disjoint writer continues using that leaf, making a lost commit answer irrecoverable. Distributed outcome context retains its exact hash/ticket/epoch/generation/time/identity tuple after the staged payload is removed. The same bounded exact-owner proof/finalization lifecycle applies to both decision kinds; prepared payloads and reserved growth never expire. Finalization follows durable publication; its failure logs/defer maintenance without revoking committed acknowledgement. Maintenance proof reads the **D-style reservation keyed by ID/hash/ticket/epoch/identity anchor**: a matching reservation must be terminal and own no entity locks; a pending reservation or anomalous lock set stays pinned. A newer same-ID reservation is proof of completion only when its distinct identity/ticket is validated and unfinished reservations are never replaced. Terminally pruned records may prove release only under that invariant and absence of the old ID's entity locks; ambiguity is not permission to unpin. Do not transplant E's B1 coarse-writer/high-watermark assumptions into G.

Keep the seven-day identity setting and fixed outcome allocation, with one ledger-defined identity-window anchor propagated to owner/participant witnesses. Nonterminal decisions/reservations and unpublished local authority do not expire even beyond that anchor. After publication, terminal expiry is eligible under the same setting; it must not leave a mismatched longer-lived participant identity that prevents reuse after the authoritative graph window. Sweeping never touches source facts. Completed migration may move fact/index/projection rows while stable owner/ledger receipts answer replay without reappending to children; retain old routed atomic outcomes through their eligible window and do not count migrated-out router facts as active-leaf membership loss.

### Bounded recovery and required evidence

Ledger recovery is admitted-protocol recovery, not a new feeder or input queue: indexed deadlines, at most 100 selected records, six concurrent drives, 10-second dispatch-start budget, active caller exclusion and per-ID execution guards. Unfinished decisions never expire; terminal sweeps are bounded and exclude active identities. Recovery of atomic delegation uses its exact local authority, distributed `committing` uses its ledger decision, cancellation confirms staged cleanup, and interrupted reservation recovery only resolves/releases ownership. Maintenance scheduling after publication cannot turn success into failed acknowledgement. Leaf pin/expiry maintenance uses bounded exact-witness proof and never supplies missing application batches. Report any recovered caller-unknown commits separately from acknowledgement throughput.

Before load, prove pooled same-ID isolation/disjoint progress, **same-leaf/shared-AV-prefix** disjoint progress and full-entity conflicts; gaps/out-of-order completion and quiescent vector visibility; partial reserve/prepare/apply/publication and real eviction; lost atomic/owner/ledger answers; SQLite rollback; pending abort/commit pins beyond synthetic expiry; bounded recovery/cleanup; capacity with simultaneous prepared growth and atomic commits; stale provisional split/epoch rejection before staging; journal/cache cold recovery; live/expired leases and completed migration replay. Audit complete indices/projections, atomic outcome membership at active leaves, exact entity ownership/tickets and terminal ledger/owner/participant witnesses read-only, hot and after restart. Default skips and synthetic accounting are not G certification or load evidence.

Only then freeze the revision and obtain two fresh G 100k matrices with repeated nearby B1 controls, unchanged corpus/client/four scenarios/Workers/IDs/retries/transport/timing. The mandatory **all four scenarios, both repeats, 100% acknowledged and durably persisted** gate remains the full-delivery certification/completion criterion. Experimental promotion instead follows the user's amended comparative rule above; incomplete results can support that limited promotion without being called successful-load throughput. Preserve all finals, source/input identities and unknown/recovery/latency/transport distinctions; a failed candidate is retained and the next independent experiment starts from the unchanged incumbent. G's evaluation alone no longer completes the amended goal if full delivery remains missing. No cloud/publication/1M/default cutover authority is implied. At this protocol checkpoint, G has not been implemented or measured.

### G implementation checkpoint (not the controlled/load gate)

The independent `storage-g/` now wires the pooled per-ID journal/recovery actor, exact entity reservations/tickets, compact fenced plans, one-leaf atomic authority and distributed authority. Fresh planning/groups are reused through admission; actor-wide typed batch cache is bounded to eight entries/4 MiB serialized input, and leaf staging uses one exact durable-payload slot. These are serialized-size/entry bounds, not measured physical heap savings. Cold plans verify complete ordered journal partitions, owner entity sets and keys before recovery RPCs.

All participant terminal outcomes use exact owner-release pins and common bounded proof/expiry; distributed apply/cancel witnesses and atomic local witnesses precede releasing topology fences. Read-only benchmark adapters check pooled terminality, owner ticket/lock anomalies, future growth and active-leaf atomic membership, including truthful all-ledger physical accounting. G has a sole-source build identity; no C/D/E/F runtime import or request-time switching was added.

Four initial G functional tests passed: complete single-leaf atomic commit/index/retraction/replay, pooled multi-owner distributed publication, authoritative abort/release, and lost atomic answer with actual ledger/leaf eviction. **26 G/client/fact-model/Datalog tests**, package/typecheck and **seven unchanged-workload harness tests** passed with G explicitly selected. This is an implementation checkpoint, **not** the full controlled concurrency/fault/expiry/migration gate or any 100k matrix. Extended controlled tests are next, and necessary corrections will be identified and freshly verified before load. A is restored as default; B1 stays incumbent until comparison/judgment. No delivery/performance/promotion claim is made.

### G controlled gate before measured comparisons

**34 explicitly selected G controlled tests / 56 G plus client/fact-model/Datalog tests pass**, with package/typecheck and seven unchanged-workload harness tests. The gate extends the implementation checkpoint: same-leaf/shared-AV disjoint progress with a lower ticket held; same-entity/different-field overlap and exact entity sets; same-bucket interleaving/same-ID exclusion and changed-payload binding; gaps/different owner tickets and fail-closed vectors; rollback; partial prepare/apply with real eviction; committed/aborted authority pinned beyond synthetic expiry; distributed outcome pinning while another same-leaf writer publishes; lost local/owner/global answers; durable apply/cancel witnesses across completed migration; interrupted split/owner eviction; one-owner/multiple-leaf distributed fallback; stale delegated generations; unadmitted reservation cancellation rather than an alarm feeder; positive preflight capacity changes and negative preflight revalidation; future prepared growth competing with atomic/distributed admission; live/expired leases; missing/corrupt journal fail-closed/cold recovery; exact leaf hot slots and bounded actor cache; synchronous schema rejection; expired identity reuse without a pin/new-lock deadlock.

Bounded maintenance tests verify **100 selected records / six concurrent drives/proofs**, 100-row terminal sweeps, no new delivery from unadmitted planning recovery, and retained facts. Recovery-bound rows are declared metadata-only fixtures; expiry anchors and capacity pressure are synthetic, not elapsed-duration, physical-capacity, performance or full-delivery evidence. Corruption fixture restoration is test cleanup, never product repair. Complete EA/AV membership and projection/retraction snapshots are checked, including rollback and migration paths; hot/restart load audits remain required separately.

A real G gate correction adds live-read-lease exclusion to split reservation. The inherited split path could begin copying while an old lease existed (the older protocol retained old-readable data through retirement fencing); G explicitly chose stricter quiescent split admission, so merely blocking writes was insufficient for its stated protocol. The new live-lease/split test found and verifies that guard. Two fixture issues were fixed without weakening contracts: clone a request before its body is consumed, and invoke a same-object alarm in that object's context rather than using an external I/O-bound stub from inside another callback.

A/B1/C/D/E/F-specific schema/global-sequence/protocol suites remain explicitly selected for their own implementations; their default skips are not G certification. G has its own applied-ticket/quiescent-vector and delegated/pooled recovery tests above. At this gate checkpoint G matrices had not begun. The subsequent frozen B1 → G → B1 → unchanged G trials below used the corrected gate revision without measured-run SUT patches, under the amended comparative promotion and unchanged full-delivery certification contracts.

### G two-repeat local results and pending promotion judgment

The four fresh serial matrices completed in the required order; all **284,000 planned logical calls / 16 scenario loads** were attempted at their frozen sizes, with no rebatching, skipping, added delivery path, mixed implementation, limit change or measured-run patch. Retained finals:

| Role | Identified source selection | Retained final |
| --- | --- | --- |
| B1 control 1 | `60972a1` | [2026-10-12T13-55-23-715Z-4bd7e0b8](../../bench/write-path/results/2026-10-12T13-55-23-715Z-4bd7e0b8/final.json) |
| G repeat 1 | `e435551` (G correction/gate `f02ddeb`) | [2026-10-12T14-18-45-346Z-612f8f61](../../bench/write-path/results/2026-10-12T14-18-45-346Z-612f8f61/final.json) |
| B1 control 2 | `99558d5` | [2026-10-12T14-37-48-924Z-f60c2d09](../../bench/write-path/results/2026-10-12T14-37-48-924Z-f60c2d09/final.json) |
| Unchanged G repeat 2 | `241c5ec` | [2026-10-12T14-58-03-344Z-04075d57](../../bench/write-path/results/2026-10-12T14-58-03-344Z-04075d57/final.json) |

Both B1 source-digest maps and both G source-digest maps are **identical within each implementation**, including harness/client inputs. B1 bundle remains `0213b0fdf6a301d63d59c115e13537729abde9dcacbea8e1d83e153067643c93`; G's sole independent bundle is `a4ab71e8dd22bdb278dd23f5e111910e8c5474be6093462b1f0af291de9b646f` (`G-integrated-write-path`). All four preserve application `7a0020d0c9fc5115b694867706b4e06520a8817d9fb755f583a5e1555418d043`, packaged client `3788367ce7fb30ecb936d3cc18a56a4cea7c9c9c634fffd14c95609109edc073`, normalized ordered 100k `2dd6061bfc95c78a90af1a2faa3ee147908981b4b6b480ed30c1726493af5309`, corpus/XML manifests, four awaited application Workers, caller-ID construction, eight-attempt/30-second/full-jitter retry/transport settings and scenario limits. Runtime remains Miniflare `5.20261006.1-alpha`, compatibility `2026-10-06`, Node `v26.11.0`; **not cloud evidence**.

Values below are **repeat 1 / repeat 2**, against each corresponding nearby control. Delivery is acknowledged and durably persisted facts out of the same 100,000 planned input facts. Rates include unsuccessful delivery and retries; they are not equal-success throughput certification.

| Facts/call × outstanding logical calls | B1 acknowledged facts | G acknowledged facts | B1 acknowledged facts/s | G acknowledged facts/s | G rate gain | B1 logical p95 seconds | G logical p95 seconds |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100 × 10 | 96,300 / 96,600 | 100,000 / 100,000 | 1,036.27 / 1,109.22 | 1,328.94 / 1,579.56 | +28.2% / +42.4% | 4.906 / 4.676 | 1.883 / 1.518 |
| 10 × 100 | 84,980 / 84,740 | 100,000 / 100,000 | 425.49 / 422.93 | 579.40 / 519.27 | +36.2% / +22.8% | 7.990 / 7.900 | 4.039 / 5.113 |
| 10 × 1,000 | 12,710 / 12,780 | 99,980 / 100,000 | 77.63 / 80.73 | 649.72 / 764.97 | +737.0% / +847.6% | 20.498 / 19.433 | 34.146 / 25.894 |
| 2 × 10,000 | 4,482 / 4,120 | 66,908 / 67,910 | 12.85 / 11.38 | 269.04 / 279.19 | +1,994.5% / +2,352.7% | 77.897 / 76.854 | 78.361 / 80.486 |

| Scenario | B1 / G attempts, repeat 1 | B1 / G attempts, repeat 2 | B1 / G 423 busy responses, repeat 1 | B1 / G busy, repeat 2 | B1 / G transport failures, repeat 1 | B1 / G transport, repeat 2 | B1 unknown calls, repeats 1 / 2 | G unknown calls, repeats 1 / 2 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Medium | 2,706 / 1,554 | 2,610 / 1,550 | 1,743 / 554 | 1,644 / 550 | 0 / 0 | 0 / 0 | 37 / 34 | 0 / 0 |
| Small | 40,677 / 16,144 | 40,768 / 16,152 | 32,179 / 6,144 | 32,294 / 6,103 | 0 / 0 | 0 / 49 | 1,502 / 1,526 | 0 / 0 |
| High | 76,188 / 19,966 | 76,292 / 19,126 | 74,881 / 3,749 | 75,014 / 3,784 | 36 / 6,219 | 0 / 5,342 | 8,729 / 8,722 | 2 / 0 |
| Saturation | 392,998 / 262,416 | 392,615 / 253,595 | 106,877 / 19,466 | 111,586 / 21,994 | 283,880 / 209,496 | 278,969 / 197,646 | 47,759 / 47,940 | 16,546 / 16,045 |

Attempt p95 seconds also change: medium B1 **0.285 / 0.228** → G **1.025 / 0.797**; small **0.277 / 0.240** → **2.178 / 3.175**; high **2.078 / 1.814** → **14.763 / 12.647**; saturation **11.050 / 10.642** → **10.977 / 10.755**. Failed fast-busy and successful awaited attempts have different mixtures, so neither attempt nor logical percentiles isolate equal-success service latency. Mean/p50/p99/maximum, committed logical/database-await samples, achieved concurrency, app distribution and host CPU/event-loop/memory observations remain in the linked finals; unavailable provider timings are unknown.

All 16 cases have valid read-only hot/restart fact/index/outcome audits; persisted facts equal acknowledgements, **zero additional unacknowledged transactions reconciled**, no pending ledger decisions, no owner locks/ticket anomalies or topology operations. Controlled fault recovery remains separate from measured delivery. G fully delivered **5/8 candidate cases**, controls **0/8**: medium/small both repeats, high only repeat 2; saturation remains short by 33,092 / 32,090 facts, and repeat 1 high by 20. Therefore **full-delivery certification fails** and the improvement objective is not complete.

Actual pooled G ledger SQLite bytes are medium **32,555,008 / 32,604,160**, small **43,995,136 / 44,011,520**, high **44,052,480 / 44,093,440**, saturation **73,695,232 / 74,797,056**, across 16 graph-scoped actors. B1 per-ID physical ledger bytes remain unaggregated; no total-storage/cold-start/lifecycle-cost advantage is certified.

**Decision checkpoint: the all-scenario/two-pair comparative delivery-and-rate gate passes, but G is not promoted yet.** High logical p95 worsens **+66.6% / +33.2%** and high transport failures rise materially to **6,219 / 5,342**; saturation p95 rises **+0.6% / +4.7%**, and small repeat 2 adds 49 transport failures. These require the user's explicit tradeoff judgment under the amended rule. Recommendation: accept G only as the **experimental incumbent** for further independent improvements, acknowledging those costs; otherwise retain B1. Until that decision, B1 remains the accepted incumbent and **A remains default**. Partial experimental promotion would not certify throughput/full delivery or authorize cloud/default cutover.

Compact finals/source/input/client/runtime identities are retained before authorized completed-run log/intermediate cleanup. Raw storage/reference/journals/bundles are not retained for retrospective replay; corpus stream/manifest and all historical evidence/implementations remain. A is restored and validated separately outside the explicit trials: **41 default tests pass / 95 candidate-specific tests explicitly skip**, package/typechecks and all seven harness tests pass. Skips are selection boundaries, not substitute candidate certification. No cloud, 1M, account/resource, publication, push or unrelated work occurred.

## Final C–F comparison and retained incumbent

**The independent C → D → E → F evaluation is complete. Zero promotions.** Each candidate was built from the actual incumbent **B1**, because its predecessor failed the mandatory all-four/two-repeat delivery gate. No losing implementation became the next base, and A remains the source/default outside explicit trials. C/D/E/F and their protocol tests remain independent preserved implementations, not a production cutover.

Acknowledged facts out of the identical 100,000-fact input, **repeat 1 / repeat 2**:

| Candidate | 100 × 10 | 10 × 100 | 10 × 1,000 | 2 × 10,000 | Full candidate cases / 8 | Promotion |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| C: pooled ledgers | 92,100 / 92,700 | 84,200 / 87,160 | 21,070 / 20,460 | 13,410 / 14,088 | 0 | rejected |
| D: entity reservations | **100,000 / 100,000** | **100,000 / 100,000** | 99,580 / 99,930 | 49,384 / 53,758 | 4 | rejected |
| E: atomic leaf authority | 97,100 / 97,100 | 86,810 / 86,920 | 13,150 / 12,810 | 4,892 / 4,672 | 0 | rejected |
| F: provisional planning/references | 98,300 / 98,300 | 85,940 / 86,340 | 37,010 / 37,150 | 10,552 / 10,722 | 0 | rejected |

These eight candidate matrices and their **eight nearby B1 control matrices** comprise 64 separate scenario loads, always 100k per scenario—not a scale-up or a larger distinct dataset. All 64 attempted every planned call, passed admitted-write/index/transaction persistence and restart checks, had persisted facts equal acknowledgements, and reconciled **zero** extra unknown commits. Only four candidate scenario cases completed fully, all D's medium/small cases; none of the 32 control cases completed. Thus no candidate achieved the required eight full cases. Preserve unknown calls, retries, transport failures and p95 tradeoffs in the individual finals/tables above; admitted integrity is not full delivery and aggregate rates cannot overrule the gate.

Descriptive local signals: C improved high/saturation partial rates but regressed medium rates in both pairs; D delivered substantially more facts and completed medium/small, without delivering the last high-concurrency calls or saturation; E's atomic authority was verified but its partial rate directions were mixed and saturation fell; F increased partial rates/delivery in every pair, with increased small/high tails and high/saturation transport failures. This is **not a statistical ranking or equal-success/cloud throughput certification**. D's larger delivery signal does not authorize bypassing its failed promotion contract; G cannot inherit a winner claim by combining these implementations.

Final consolidation read all **16 retained source-identified finals** and verified identical corpus/reference/settings, application bundle and packaged-client digest; driver/runtime/scenario/application/corpus source hashes were fixed. All eight B1 controls have identical Worker bundles, and each candidate's two repeats have identical Worker bundles. Every final folder contains only its `final.json`; no retroactive raw replay claim is made. The actual retained corpus cache hashes to `e09d65047fe1479eacc7823761526d8280e3071d5c805ddf4b9bef43acb29064`; its normalized selected 100k prefix is `2dd6061bfc95c78a90af1a2faa3ee147908981b4b6b480ed30c1726493af5309`. Application bundle: `7a0020d0c9fc5115b694867706b4e06520a8817d9fb755f583a5e1555418d043`; packaged client: `3788367ce7fb30ecb936d3cc18a56a4cea7c9c9c634fffd14c95609109edc073`. Runtime/client/corpus details and all source identities stay in each final, indexed by the [results README](../../bench/write-path/results/README.md).

Controlled gates were explicitly selected: C/D shared plus controlled **34 tests** each, E **36**, F **39**, plus package/typecheck and seven unchanged-workload harness tests. Final restored-A validation passed **41 tests / 61 explicit candidate/historical skips**, package/typecheck and all seven harness tests. A-specific global sequence/schema fixtures are not universal candidate tests; skipped default suites were never candidate certification. Source facts are indefinite; seven days remains the retained identity/outcome setting, and unfinished decisions cannot expire.

Cleanup retained finals before removing authorized completed-run raw/reference/bundle/progress/log intermediates; `.data/` now contains the corpus stream/manifest only (about 337 MiB), and results retain compact finals (about 2.3 MiB). Historical A/B1 evidence remains. No retrospective trial-source/history rewriting, unrelated video deletion, competing benchmark, push, cloud deployment, account change, npm publication, 1M trial or default cutover occurred.

There is **no evaluation blocker**: ordinary incomplete delivery required rejection, not abandoning the next experiment. Remaining limitations are not hidden: no full-delivering incumbent/winner, no measured physical per-ID storage/cold-start/lifecycle benefit, public vector-token API unresolved, local-only performance, and no universal correctness proof. G was proposed separately during C–F and is now authorized through the separately confirmed goal `mv5798ar-prbz27`; it is not part of this completed C–F evaluation. Its D/E integration must not use a high watermark alone as publication proof for an unfinished lower ticket; pooled recovery, exact entity reservations, delegated authority and provisional routing require a new combined protocol and gates.

## Summary

Build `bench/write-path/` as a repeatable application-level benchmark of Poneglyph's ordinary `stateFacts` API. A local driver converts the already-downloaded One Piece corpus into regular facts and sends bounded HTTP requests to one or more application Workers. Those Workers consume the packaged Poneglyph client and await writes to one deployed database containing one graph. Actual fact, index, transaction, and recovery state must be persisted; acknowledgements of queued work are not successful commits. First measure the implementation currently on disk, then the proposed hash-routed, independently sharded fact/index store trees with distributed transaction coordination. Keep the benchmark, dataset, transport, and common workload parameters fixed between versions. Every version and planned scenario must pass end-to-end correctness tests in Miniflare before deployment. Only Cloudflare runs are evidence of cloud performance.

## Context

The current TypeScript implementation has expandable 256-bit entity-prefix routing, local fact/index projections, and one `GraphCoordinatorDO` per graph. The coordinator serializes graph write decisions and publishes a global visibility sequence; storage sharding does not distribute this authority. [RFD0004](./RFD0004-expandable-cloudflare-sharding.md) describes that implementation and its bounded evidence.

The existing [One Piece harness](../../examples/onepiece-load.ts) starts a local Worker and writes serialized batches of up to 500 facts directly to its HTTP endpoint. The existing [local benchmark](../../poneglyph/tests/throughput-bench.test.ts) also bypasses the public client and caps concurrency at 16. Neither is the desired application-client-database experiment at 1,000 concurrent calls.

At the start of the experiment, the working-tree [client](../../poneglyph/src/client.ts) offered `state`, `transact`, and `query`, not `stateFacts`. The benchmark implementation adds `stateFacts` as a client entrypoint to the unchanged baseline transaction path. It accepts injected `fetch`, caller-provided transaction IDs, and does not retry automatically. Its receipt includes `commitSeq`. The baseline must include the reviewed working-tree code, not silently substitute the last committed revision; capture the source actually built.

The corpus is already downloaded locally. It is input to an application workload, not a reason to add an import subsystem to the database. Changing batch size and concurrency can change write amplification and contention. More application Workers may remove an application bottleneck, but cannot by themselves remove the baseline's single graph coordinator.

## Goals

- Measure the real write path through the packaged client, including actual persistent facts and required index updates.
- Compare transaction batching against concurrent smaller transactions, including 10 facts per call and 1,000 in-flight calls, and 2 facts per call and 10,000 in-flight calls.
- Support multiple application Workers feeding the same database and same graph.
- Establish a reproducible current-code baseline before changing storage architecture.
- Compare that baseline with independently routed fact/index store subtrees and distributed transaction coordination.
- Verify write correctness locally before spending account resources on cloud performance measurements.
- Expose rejected requests, retries, ambiguous outcomes, contention, routing, and storage/index amplification rather than hide them behind a throughput average.

## Non-goals

- An import API, special import completion token, source connector, queue, workflow, or background ingestion service.
- Resolving `query(txId, query)`, latest transaction, historical read, cursor, or graph-wide snapshot semantics. Queries here are post-write verification tools, not a query-throughput experiment.
- Public npm publication, changes to unrelated resources, or modifications to FokosDB.
- A physical 50 GB/1 TB load, synthetic capacity accounting presented as writes, an SLA, or a claimed universal database throughput.
- Weakening append-only semantics or removing required indices to obtain a favorable candidate result.

## Design

### Application flow and boundaries

```text
local corpus -> local HTTP driver -> application Worker(s)
                                      -> packaged Poneglyph client
                                      -> one Poneglyph database Worker
                                      -> SQLite-backed Durable Objects
```

The application exposes an authenticated, bounded `POST /facts` accepting `{txId, facts}`. It validates the envelope, calls the package API, awaits the database result, and returns `{txId}` only on success. Application errors must preserve useful failure classifications without leaking secrets. Curl can exercise the endpoint; the load driver uses that same endpoint and contract. There is no success response followed by a `waitUntil` commit.

The implemented public write API is:

```typescript
const db = createDatabase(poneglyphConfig);
const txId = await db.stateFacts(facts, { txId: requestTxId });
```

`createDatabase` is synchronous local construction. `stateFacts` is the implemented public write operation; the options retain caller-supplied identity for retries. The baseline may make this small client-surface change but must not redesign storage, change limits, or add a faster internal write path. Document/package-test that change. Keep baseline-only receipt/sequence details out of the application contract. One configured graph is used throughout a deployment; do not distribute load across graph IDs to evade the coordinator.

The package is built and consumed through its exported interface as a pinned artifact, not via source imports into storage internals. Use a private local package artifact; a public npm release is unnecessary. Select HTTP over a service binding through the client's injectable `fetch` if supported and validated; otherwise authenticated HTTPS. Freeze the chosen transport across database comparisons and record it. The application never receives DO bindings or bypasses the database's transaction path.

Suggested layout (proposed files):

```text
bench/write-path/
  worker/        # benchmark application and deployment configuration
  corpus.ts      # local-only deterministic fact extraction
  scenarios.ts   # workload and scheduling definitions
  run.ts         # bounded HTTP driver, receipts, verification, reports
  tests/         # multi-Worker Miniflare and failure tests
  results/       # small manifests/summaries, not corpus or secrets
  README.md      # reproducible commands and account/resource procedure
```

### Version A: current code on disk

Capture a buildable snapshot of the current implementation, including reviewed uncommitted client changes. Record the Git base, source-tree digest, and an archival patch or commit sufficient to reproduce the built source. Preserve unrelated working-tree changes. Freeze this baseline before developing Version B.

Run the current coordinator, participant, split, and index behavior without tuning away its bottlenecks. Use separate benchmark deployment configuration; do not repurpose the previous scale-out/TODO validation configuration or its resources. Store baseline reports even if concurrency mostly produces busy responses.

### Branch-by-abstraction staging

The SUT composition root is [`poneglyph/src/database-implementation.ts`](../../poneglyph/src/database-implementation.ts). The existing Worker imports its coordinator naming function and DO exports through that module. It selects `storage/implementation.ts` (Version A) by default. The alternative is `storage-candidate/implementation.ts`, an independent duplicate of the storage runtime, not subclasses of Version A. Coordinator, participants, routing, SQL schema, capacity, protocol, limits, and query storage code can now change there without altering the baseline. Portable domain parsing and Datalog semantics remain shared.

Selection is explicit at build/source composition, not a request-time flag, automatic fallback, or mixed implementation within one deployment. To build the fork, change only the composition-root export target to `./storage-candidate/implementation.js`, use fresh persistence/namespaces, and record that source selection. Restore Version A for ordinary builds. The candidate has distinct `candidate-coordinator`/`candidate-shard` schema-kind markers and rejects Version A databases, even though its initial tables are a copy. Never point a selected candidate at persisted baseline data. Object-name encoding is initially unchanged within separate namespaces; it is not an in-place migration mechanism.

Historically, the benchmark code under `bench/write-path/` was unchanged by the initial staging step: application/client path, corpus extraction, scenarios, batching, retries, transport, timing, and existing audits remain fixed. Implementation selection is SUT wiring, not a second feeder or candidate-only fast path. Any future schema-specific audit adapter must preserve the same independent integrity obligations and remain outside timed writes; do not weaken an audit to accommodate the candidate. Before candidate performance runs, its separately identified version must be reflected in report metadata—the runner's current hardcoded Version A label is not suitable for a redesigned Version B.

At that initial staging checkpoint, the fork was **not yet the concurrent model**: it still has Version A's serialized writer, visibility watermark, colocated indices, and query semantics. No read-your-writes token contract, disjoint-owner progress, or throughput improvement is claimed. The next implementation step must specify the actual participant/index/decision/recovery/visibility/fencing protocol below, then modify only the candidate and prove controlled disjoint-owner progress and overlap safety.

Staging validation selected Version A and passed 41 package tests (one skipped), then selected the fork and passed the same 39 existing package tests (one skipped) plus all six unchanged benchmark harness tests. The two additional boundary tests assert the default Version A selection and rejection of baseline schemas, so they are tested only with Version A selected. The default was restored afterward. These are small correctness/wiring fixtures, not a new 100k measurement or proof of concurrent progress.

Coexistence is required for matched baseline/candidate comparisons. Remove the fork-selection scaffolding and obsolete implementation only after an explicitly accepted cutover; do not leave compatibility layers indefinitely. No new architecture RFD is created by this staging step; this amendment records the boundary in the existing experiment contract.

### B1 implementation: independent subtree gates

The first modified fork is **B1-independent-subtrees**, a narrower experiment than the separate index trees below. One graph has sixteen initial 4-bit entity-hash tree roots, each retaining the copied expandable descendant/split protocol. Fact log, entity view, active tuple index, and EA/AV SQLite access paths remain colocated on the entity's leaf and commit locally together. This does not yet measure separately routed index trees or exact-key concurrency within one owner; those remain a later candidate. Disjointness means nonoverlapping actual subtree owner sets, including all local index/projection mutations.

The stateless database Worker parses ordinary transaction requests and routes them by graph/transaction ID directly to a durable transaction object in the coordinator namespace. It does not pass every write through the graph facade/root. That object binds identity to payload and owns a durable intent/decision. A one-tree batch uses the duplicated local tree protocol. A cross-tree batch acquires owner gates in deterministic order, rejects contention without waiting indefinitely, persists its leaf plan, preflights/prepares every participant, persists an irrevocable commit decision, applies every fact/index participant, then publishes each owner's sequence/releases its gate. Acknowledgement follows every apply and every owner publication. Same-ID/payload retries resume the durable phase; changed payload conflicts even if it would route to another tree. No queued success, automatic client retry, or fallback feeder is introduced.

A transaction's sequence is `max(locked owner sequences) + 1`; disjoint transactions may have the same number. **This is not a global transaction order.** Receipt `commitSeq` is subtree-scoped. Reads acquire a bounded lease on every initial tree before scanning; acquisition fails and releases the partial cut if any writer/topology gate is busy. Writers cannot enter leased trees. Leaves filter by their own leased sequence/epoch, and expired leases fail closed. Thus a successful query cannot straddle partial cross-tree apply/publication, and a read after acknowledged writes observes them or later updates/retractions. Unlike Version A, reads temporarily impede writes. The raw query returns `sequenceScope: subtree-vector` and a `snapshotVector`; its compatibility `snapshotSeq` is the maximum owner sequence, **not** a graph-global read token. The unchanged packaged client buffers rows and that scalar but does not yet expose the vector; token/latest/public snapshot API decisions remain deferred.

No graph-wide durable write reservation or per-write counter remains. Capacity/fact/byte/participant/query limits are unchanged. The retained-outcome ceiling is conservatively divided into 6,250 terminal owner records per tree (100,000 total placements); cross-tree outcomes consume multiple placements, so the effective distinct-outcome bound can be lower, never higher. Transaction records remain payload-bound for seven days. A cross-tree capacity/split-needed preflight aborts without effects rather than splitting while holding multiple gates; single-tree preflight/manual operations retain bounded split/copy/cutover/recovery, now fenced only within that tree. Virtual forest routers are computed metadata with no fact rows. No in-place data migration is provided; schema version 2 and fresh candidate namespaces/persistence are mandatory.

The workload/application/client/scenarios/driver/retry/latency path remains fixed. SUT-specific read-only audit classes now live behind the same implementation boundary; the benchmark adapter selects them. The small-fixture auditor now walks real routers as the full streamed auditor already did. Candidate audits additionally compare each leaf against its own owner watermark, inspect every owner-referenced transaction coordinator, and probe caller-unknown/rejected IDs for unclaimed unresolved intents. These are stronger, untimed checks, not repaired storage or weakened invariants. Build metadata derives A/B1 identity from the actual bundled SUT instead of retaining the old hardcoded A label.

Local controlled tests hold a committing A and demonstrate disjoint B completes, verify overlapping writes and graph reads return busy, recover after partial apply without duplicate facts, abort invalid cross-tree retractions, reject changed-ID payloads across roots, expire read leases, and recover an interrupted subtree copy while another tree writes. The same packaged-client harness tests still cover 100/101/1,000-entity batches, replay/query, scalar indices, and restart. A full 100k matrix remains necessary to establish delivery and audit behavior under real load; these fixtures alone do not establish an improvement or authorize cloud deployment.

#### First B1 100k result — 2026-10-11

Final report: [`2026-10-11T19-06-36-247Z-041e975c/final.json`](../../bench/write-path/results/2026-10-11T19-06-36-247Z-041e975c/final.json), bundled revision `c6b5680`, clean source tree, correctly identified as `B1-independent-subtrees`. All four cases attempted every planned call at its configured size through the unchanged feeder/application/client path. Each passed persisted fact/index/transaction and restart audits, including the additional owner/transaction-object checks. No caller-unknown write was secretly committed and no unresolved transaction decision was found. Final-only retention completed before removal of temporary state.

Comparison against the **historical corrected** A run (`a21b9a6`), not a new interleaved or contemporaneous control:

| Facts/call × concurrency | A acknowledged | B1 acknowledged | A local acknowledged facts/s | B1 local acknowledged facts/s | B1 rate change | B1 unknown calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 × 10 | 93,700 | 94,300 | 1,286.11 | 1,032.86 | −19.69% | 57 |
| 10 × 100 | 68,780 | 85,930 | 310.48 | 449.55 | +44.79% | 1,407 |
| 10 × 1,000 | 5,820 | 12,840 | 30.14 | 84.28 | +179.60% | 8,716 |
| 2 × 10,000 | 2,298 | 4,446 | 8.03 | 13.21 | +64.50% | 47,777 |

B1 improved admitted volume in every case but regressed the medium-batch acknowledged rate. It made 2,613 / 39,715 / 76,396 / 392,550 attempts respectively. Status-423 attempts were 1,670 / 31,122 / 75,112 / 116,531; saturation additionally had 273,796 local transport failures. Logical-call p95 was 5.11 / 7.78 / 18.72 / 75.17 seconds. These numbers describe retry-inclusive logical calls, not independent commit concurrency or cloud request ceilings. Saturation still primarily measures local overload, not deployed storage capacity.

**None completed its full 100,000-fact input.** There is no successful-load throughput winner, repeated improvement, production cutover, cloud performance claim, or justification for 1M yet. The default composition was restored to A after this bounded trial; B1 remains independently selectable for fresh-persistence experiments. Before the trial, A passed 41 package tests (one historical skip, plus five candidate-only skips), B1 passed its five controlled protocol tests, and the same six packaged-client harness tests passed against both implementations. Baseline-specific coordinator SQL/global-sequence tests are not automatically a B1 compatibility certification.

B1 also creates a DO per transaction and adds read-cut/query fanout. Its `databaseBytes` reports do not aggregate every transaction-object database; the audit explicitly marks that storage scope and leaves transaction storage bytes unknown. Logical seven-day retention permits terminal identity expiry, but idle transaction objects have no self-driven physical sweep. Lifecycle, deployed invocation/storage cost, full delivery, stronger fault/topology interleavings, and eventual public vector-token exposure remain gates, not silently satisfied by this result.

### Version B: parallel store trees

The experimental candidate has separate fact and required index store trees, with durable leaf/router ownership over versioned 256-bit hash keys. Fact ownership uses canonical entity identity; an entity's canonical facts remain colocated. EA/AV and other supported index entries are replayable derived state, not a mutable replacement for the fact log. Each index has an explicitly defined canonical routing tuple; routing AV solely by attribute is not assumed. For example, routing by `(attribute, value)` permits different values to reach different leaves, but a hot exact tuple may still contend.

Plan a transaction's actual fact and index participant owners, stage all mutations, persist one commit/abort decision, and apply/recover idempotently. Route transaction control across a coordinator pool by transaction identity, or an equivalently demonstrated distributed mechanism. No graph-wide writer reservation, root router, or global transaction metadata update may remain an unnoticed per-write serialization point. An opaque transaction ID does not require a global incremental allocator.

The hypothesis is that transactions with disjoint **actual participant owner sets** can progress concurrently. Different entity URIs alone are insufficient: their index writes may share an owner. Contention at shared owners remains allowed and must be measured. Do not promise unlimited parallelism from a hash function.

Before implementing Version B, specify its exact index set and key encodings, participant conflict rules, transaction decision/recovery records, identity retention, and split fencing in a companion architecture RFD or amendment. Account for every required index participant in limits. Preserve append-only facts, payload-bound idempotency, durable outcomes, and atomic transaction visibility; this experiment does not waive those invariants. The old global `visible_seq` mechanism cannot simply be deleted and replaced with independently visible participant writes. The write-only benchmark does not settle a replacement public query contract or prove multi-shard reader atomicity.

Version B is deployed in new versioned namespaces. No in-place reinterpretation of Version A's storage and no baseline-data migration are required for this experiment.

### Workload and dataset

Extract one deterministic ordered fact stream from the entire locally downloaded One Piece XML. Record archive/XML checksum and bytes, extraction version, page/entity/fact counts, canonical fact-stream digest, value/field distribution, and duplicates. Reuse extraction logic where suitable, but audit it first: the existing extractor caps categories/links, uses potentially colliding title slugs, and adds hand-authored domain facts. State these policies explicitly, prevent unintended entity collisions, and distinguish corpus-derived facts from any supplemental correctness fixtures. Processing every page does not imply preserving all wiki text or every link.

Corpus decoding is local workload preparation, not a database feature. Generate a bounded on-disk stream/manifest before timing so parser/CPU stalls do not masquerade as database limits. The canonical payloads include real values; no synthetic payload-size substitutions. Keep extraction fixed between versions and scenarios. Do not commit the downloaded corpus.

Following the user's revised direction, the iteration comparison defaults to the same first **100,000 facts in every scenario**. Increase to **1,000,000** only after repeated matched trials establish better throughput without durability, required-index, atomic-visibility, or recovery regressions. The complete prepared corpus has 1,530,195 facts; 100k is explicitly an iteration cohort, not a full-corpus load. Every planned batch must be attempted at its stated size, including batches that expose database defects. Do not patch storage during a trial, raise retention limits, shrink/rebatch, skip input, or add a fallback write path to make a scenario complete. Authorized product bug fixes require a separately identified revision and new measurements, as recorded below.

The user subsequently removed both concurrency-1 cases. All current load cases have multiple outstanding calls; single-request protocol fixtures remain correctness tests, not load scenarios. The serial runs and other earlier generated results were explicitly deleted at the user's request and are not evidence for this restarted comparison.

| Scenario | Target facts/call | Maximum concurrent logical calls | Facts in a full initial wave |
| --- | ---: | ---: | ---: |
| Parallel medium | 100 | 10 | 1,000 |
| Parallel small | 10 | 100 | 1,000 |
| Highly concurrent small | 10 | 1,000 | 10,000 |
| Single-authority saturation probe | 2 | 10,000 | 20,000 |

The 10,000-call scenario is intended to expose the single-DO coordination bottleneck using very small transactions. Cloudflare documents approximately 1,000 requests/second per object as a soft limit, with achievable throughput depending on work per request [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/); neither 2,000 RPS nor any other fixed rate is a Poneglyph benchmark or guaranteed hard ceiling. In-flight calls are not requests/second. Measure the actual arrival/attempt rate, completion rate, busy/overload responses, and retry amplification. Ramp to 10,000 outstanding logical calls within explicit local/cloud resource and request caps; do not assume the driver or application Workers can sustain that target. Additional application Workers/drivers may supply load but cannot remove a shared database coordinator bottleneck.

A logical call occupies one slot from its initial attempt through bounded retry or final outcome. Refill a slot when it finishes until the corpus is exhausted; this is sustained closed-loop load, not only one burst. Record ramp-up, achieved concurrency, tail/drain time, and backoff occupancy. Use identical fact order and batching policy; the final batch may be smaller and is reported. Assertion/retraction ordering tests are separate from the assertion-oriented corpus workload.

The current limits are [1,000 facts, 1,000,000 canonical bytes, and 32 participant leaves per transaction](../../poneglyph/src/storage/constants.ts). Preflight and record actual serialized request size and effective database limits. A configured 1,000-fact batch may exceed byte or participant limits; report the unsupported/rejected scenario without silently shrinking it. If a separately labeled byte-bounded variant is needed, preserve its realized batch distribution and compare that same variant across versions. Never compare only the convenient accepted subset as if the whole corpus succeeded.

Application Worker count is an independent parameter: start with 1 and compare 4 workers, expanding only when measurements show an application/driver bottleneck. All point to the same database. Cloud routing need not yield distinct physical isolates; multiple names are not proof of added execution capacity. Fix Worker count in paired comparisons and record observed distribution.

### Local correctness gate: Miniflare first

For each version, run the actual application/package/database path under Miniflare with SQLite DO persistence and local service bindings or the selected equivalent HTTP transport. Run every planned scenario, including the 1,000- and 10,000-concurrent-call cases and multiple application Workers, over the corpus. Separately use small controlled fixtures for deterministic failures. A complete outcome report is required; error-free admission at every concurrency is not required, but every admitted outcome must be correct and unmet workload targets must be recorded.

Required checks:

- Awaited success corresponds to durable completed writes to every required fact/index participant, not acceptance into a buffer.
- Expected facts are present exactly once per successful transaction despite same-ID/payload retries; same ID with a changed payload conflicts within the documented retention window.
- A bounded quiescent audit reconciles expected facts, transaction membership, and every required index entry, detects missing/extra rows, and verifies reverse/index lookup paths. Active tuple counts are not a substitute for fact-log counts when assertions repeat.
- Restart the local database runtime using the same persistence and repeat verification. An application Worker restart must not require a remembered transaction list to recover database state.
- Reject invalid batches/retractions and over-limit transactions without partial effects. Include retraction/index removal and batch-order tests.
- Interrupt before prepare completion, after the durable decision, and between participant applies; lose responses; retry and recover. No irreversible commit is subsequently aborted; cancelled transactions have no active/index effects. Transport timeout alone is not evidence of abort.
- Exercise stale routes and split/cutover/recovery against actual staged transactions for the candidate. Existing single-writer/global-split tests alone do not cover overlapping candidate writers.
- Prove candidate disjoint-owner progress with controlled participant barriers: hold one transaction at a participant and demonstrate another disjoint transaction can finish. Test shared-owner contention separately. Do not infer parallelism from merely launching promises or from local timing.

Verification can use restricted read-only audit hooks when public query limits prevent complete enumeration. They must not bypass writes, repair data, enter the timed path, or be publicly exposed in cloud deployments. Run bounded public query checks too. Fault injection is local, not an unbounded destructive cloud exercise. Miniflare measures correctness/reproducibility only, never Cloudflare capacity.

### Cloud performance protocol: only after the local gate

1. Verify the personal account, effective limits, available usage visibility, resource names, and explicit run caps (facts, requests including retries, duration, concurrency, and estimated cost). If cost/usage cannot be observed, state the gap and obtain an agreed bounded budget before the full run. Do not claim included usage or zero incremental cost.
2. Build/typecheck/package-test and dry-run the dedicated database deployment. Deploy it first with fresh storage, then deploy authenticated application Worker(s) with the pinned client and database connection. Smoke-test the same path before corpus traffic.
3. Run each admitted corpus scenario in fresh storage for each trial. Prefer at least three paired trials per comparable scenario, with recorded ordering to reduce time-of-day confounding. A trial must be large enough to exercise sustained concurrency; label short runs as exploratory, not steady-state/tail evidence.
4. Separate untimed application/transport warm-up from the measured fresh-database load. Warming a different namespace does not warm the measured database's DOs; report those first-use costs instead of claiming a fully warm run. Any additional warmed/preloaded trial is a separate scenario with its initial data and topology recorded. Record initial/final topology, placement hints, splitting, routing cache state, capacity configuration, and DO counts.
5. Record both ordinary fresh-tree/corpus behavior and separately labeled controlled-topology contention experiments. Version A may remain on one unsplit leaf at this corpus size. Controlled pre-splitting is untimed setup, not a faster write path; freeze and report it. For candidate disjoint-owner tests, verify leaf owner sets across facts **and all indices** rather than claim disjointness from entity names.
6. Send real fact batches through the application, await successful completion, and persist actual fact/index/decision rows. No no-op database mode, mocked participants, delayed indexing, or synthetic byte accounting.
7. After traffic drains, reconcile ambiguous outcomes, run quiescent persistence/index audits and bounded public queries, and mark trials with missing/partial/corrupt data invalid. Do not publish favorable throughput from invalid trials.
8. Retain deployment/data until cleanup is explicitly approved. List all created resources and their ownership; any teardown removes only experiment resources and verifies completion.

Use bounded connections and timeouts in the driver; allow multiple driver processes if one cannot sustain the target, with coordinated unique identities and a shared timing/report manifest. Inspect CPU, payload-read stalls, connection limits, application distribution, and scheduling lag. Do not label generator saturation as database saturation.

### Outcomes, retry, and measurement contract

Use unique transaction IDs derived from run/scenario/ordinal, not graph-global order. Persist a local request/receipt journal to resume delivery and audit outcomes. This is test-driver state, not a database import pipeline. Retry the exact ID and payload with bounded backoff/jitter on classified retryable failures; freeze retry policy across versions. The SDK must not acquire invisible automatic retries. Report non-retryable rejection, retry exhaustion, and ambiguous transport failures separately. Reconciliation uses same-ID replay or a supported status operation; any unresolved transaction stays unknown, not silently failed or counted successful.

Timing begins when the driver first submits a logical call and ends on its final acknowledgement/outcome. End-to-end latency includes retries/backoff; separately record each attempt latency and application time awaiting `stateFacts`. Do not subtract network time and present the remainder as measured database execution time. Telemetry may separately measure internal stages.

Report:

- Unique acknowledged committed facts/s and transactions/s over the full timed workload, including ramp/drain, plus interval throughput. Do not count retry payloads as new facts. Separately report commits discovered only by later reconciliation and time-to-reconciliation.
- Logical-call and attempt latency distributions, success/failure counts, unknown outcomes, retry/backoff counts, completed facts, actual batch sizes/bytes, and achieved outstanding-call distribution.
- Raw sample count and percentile method. Publish p50/p95/p99 only with adequate samples (target at least 10,000 completed calls for p99); otherwise label tails insufficient. Across trials show each result and spread, not only the best.
- Per-stage timings when available: client/database request, route resolution, prepare, decision, apply/completion; participant fan-out and coordinator/leaf contention, split pauses, routing hops/cache hits, SQL row writes, reported physical storage, and amplification. Missing provider metrics are unknown, not zero.
- Exact source/artifact digests for database, client, and application; harness revision, runtime/tool versions, limits, retry policy, transport, Worker count, dataset manifest, topology, run timing, account plan, and verified local gate identifier.

Keep traces/logs structured and sampled consistently. Enable logs and traces for the dedicated deployments; never log corpus bodies, secrets, or auth headers. Retry storms and excessive instrumentation can distort results and incur costs. Preserve the final aggregate in `results/` with source/dataset/artifact digests. Per the later explicit retention direction, raw samples and intermediate storage are temporary and removed after runtime/ledger close and successful final-report save; console logs are cleaned up separately. Their absence limits retrospective replay/debugging and must not be described as archival retention. No benchmark result exists until implementation and execution complete.

## Acceptance criteria and interpretation

The experiment is usable when its application consumes the packaged `stateFacts` API, its scenarios replay identical inputs, its local gates audit durable facts/indices and failure recovery, and its cloud runs save reproducible outcome/latency/throughput reports. A baseline completing with contention or unsupported scenarios is still informative; it must not be silently optimized before recording.

Version B supports the architectural hypothesis only if disjoint-owner progress is demonstrated locally, every required index still participates, correctness gates pass, and paired cloud runs show an improvement under the relevant scenario without hiding errors, retry time, storage amplification, or changed limits. No improvement is a valid result. The real corpus measures practical shared-index contention; controlled disjoint/shared-owner fixtures explain the mechanism and are never mislabeled corpus results.

This comparison intentionally includes the cost of separately stored indices in Version B. It is a whole-design comparison, not an isolated claim that coordinator sharding alone caused a speedup. If attribution is needed, add a separately labeled intermediate version without replacing the required baseline and candidate.

## Alternatives

| Alternative | Reason not selected |
| --- | --- |
| Extend only the current direct-endpoint script | Does not validate the deployed application's packaged-client path or 1,000 concurrent calls. Reuse extraction, not its bypass. |
| Direct DO writes or queued acknowledgements | Removes transaction/index completion work and measures a different database contract. |
| Only local benchmarks | Useful for debugging and correctness; not evidence of managed Cloudflare performance. |
| Deploy first and validate afterward | Risks paying for fast but incorrect writes; violates the mandatory local gate. |
| Many graphs/databases to increase throughput | Avoids the per-graph bottleneck instead of measuring parallelism within one graph. |
| Do nothing / only tune the driver | Leaves no reproducible application-level baseline and cannot establish the proposed architecture's benefit. |

## Consequences and open questions

- The benchmark creates real billed compute, SQL/index writes, and retained storage. Increasing concurrency can increase retry traffic without increasing useful throughput.
- Large transactions can span more owners, amplify failure cost, or exceed limits; smaller transactions add coordination/HTTP overhead. Measuring the trade-off is the point.
- Corpus loading grows the database throughout a run. Fresh/controlled topology and interval measurements are needed to distinguish batching, contention, and split effects.
- Before implementation: accept the experiment contract and public `stateFacts` naming. Before Version B: specify the participant/index/conflict/recovery/split protocol and explain how atomic visibility is preserved without claiming a completed snapshot redesign.
- Implementation-time: verify the pinned tooling's multi-Worker Miniflare support and service-binding client adapter; establish collision-free fact extraction and bounded full-data audits.
- Before cloud execution: agree the target account/resources and hard cost/work limits, including a stop policy for retries, storage growth, and invalid data.
- Out of scope: choosing a latest read token, total transaction order, or public stable-graph-snapshot API.

## Implementation and evidence reset (2026-10-11)

### Implemented local harness and reproduction

The implemented path is local HTTP driver → gateway → 1–32 application services → pinned `file:` package client → database Worker service binding → real Miniflare SQLite DOs. The gateway only selects local application services; it is not a database coordinator. All applications use one graph/database per trial. Benchmark subclasses inherit production write methods unchanged and expose restricted read-only audits through a token-protected local entrypoint. Audit routes must not become public cloud routes.

```sh
# From repository root.
cd poneglyph
pnpm run build:package
cd ../bench/write-path
pnpm install
pnpm run typecheck
pnpm test
pnpm run prepare:corpus
pnpm run preflight
BENCH_FACTS=100000 BENCH_WORKERS=4 pnpm run run:local
```

`prepare:corpus` reads cached `tests/fixtures/cache/onepiece-pages-current.xml` or accepts another XML path as its first argument. It prepares ordinary page-derived facts with exact percent-encoded title identities, at most eight categories/sixteen links per page, no full text, no namespace filtering, and no supplemental hand-authored domain facts. This avoids the legacy extractor's lossy-slug collisions. Preparation produced 1,530,195 facts from 296,624 pages; XML bytes 436,781,838, SHA-256 `1446ff8fca4bdebd289e5a546d67078d1170369fb3bfb65a35c758d53cd4e084`; fact-stream SHA-256 `e09d65047fe1479eacc7823761526d8280e3071d5c805ddf4b9bef43acb29064`. Corpus inputs/manifests remain cached, not committed.

`preflight` is informational: it does not write data, shrink batches, skip cases, or prevent exercising a database defect. The current matrix has only the four concurrent scenarios above; removed serial cases and earlier artifacts are not evidence for this iteration.

| Environment variable | Default / bound |
| --- | --- |
| `BENCH_SCENARIOS` | All four; optional comma-separated known names: `parallel-medium`, `parallel-small`, `highly-concurrent`, `saturation`. |
| `BENCH_FACTS` | 100,000; maximum 2,000,000, and the requested prefix must exist. 1M scale-up is deliberate, not automatic. |
| `BENCH_WORKERS` | Four application services, maximum 32. |
| `BENCH_ATTEMPTS` | Eight per logical call, maximum 30. |
| `BENCH_TIMEOUT_MS` | 30,000 per attempt, maximum 120,000. |

Retries retain the exact ID/payload and use full-jitter exponential backoff from 100 ms to 5 seconds; a slot includes retry/backoff time. IDs are unique per run/scenario/batch. Successful responses await commit. Caller-unknown outcomes stay unknown and are separately reconciled against quiescent storage; absence at audit is not a successful load.

The driver streams only outstanding batches in memory and retains latency samples for exact nearest-rank percentiles. p95 requires at least 1,000 samples and p99 at least 10,000. A disk-backed reference/outcome ledger checks transaction membership, duplicate multiplicity, missing/extra acknowledged facts, partial persistence, and rejected writes unexpectedly persisted. Paginated router/leaf audits reconcile active scalar fact/value indices, terminal participant/coordinator state, fact-log associations, Datalog values/types, and visibility before/after restart. Local application activity/drain probes are not distributed cloud-isolate counters. The small-fixture auditor now walks initialized router/leaf topology; the streamed audit covers the scalar assertion corpus, not arbitrary nested/retracted data. Retraction, failure, public query and split semantics use separate package tests. Candidate overlapping-writer/fault/barrier coverage remains required.

### Final evidence retention and interpretation

Completed trials retain `results/<run-id>/final.json`: source/artifact/dataset identity, final metrics, classifications/reconciliation, and pre-/post-restart audits. Per-case reports and raw SQLite/input/reference/journal/bundle/progress artifacts exist temporarily during execution. After runtimes/ledgers close, the final aggregate is saved **before** removing intermediates. Console logs are handled separately. Tokens and corpus bodies are not saved in final reports. Raw archival replay is not possible from the final aggregate alone; reproducibility relies on the recorded source and input identities. Incomplete/failed loads must never be relabeled successful.

Reports distinguish acknowledged unique throughput, all-outcome versus successful-call latency and sample counts, unavailable tails, retries/statuses/transport errors, achieved logical concurrency, fact/index/terminal-state/restart correctness, and local versus unmeasured cloud performance. Both retained 100k matrices attempted every planned batch at its configured size without adaptation. Earlier generated artifacts were explicitly deleted and are not current comparison evidence. The [result README](../../bench/write-path/results/README.md) is a file index, not an independent contract.

| Facts/call × concurrency | Pre-fix acknowledged facts | Pre-fix unknown calls | Pre-fix facts/s | Corrected acknowledged facts | Corrected unknown calls | Corrected facts/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 × 10 | 93,900 | 61 | 1,292.44 | 93,700 | 63 | 1,286.11 |
| 10 × 100 | 67,940 | 3,206 | 303.61 | 68,780 | 3,122 | 310.48 |
| 10 × 1,000 | 5,740 | 9,426 | 29.13 | 5,820 | 9,418 | 30.14 |
| 2 × 10,000 | 2,398 | 48,801 | 8.39 | 2,298 | 48,851 | 8.03 |

Each case attempted the same 100,000-fact prefix through four application Workers into fresh storage. Both matrices passed fact/index/transaction and restart audits, with no additional unacknowledged commits or unresolved decisions. Caller-unknown transactions were uncommitted at quiescent audit. **None completed the full load.** The corrected revision is `a21b9a6`; single-pair local rate differences do not establish improvement. Coordinator contention remains; local transport/runtime limits also contribute at high concurrency. This is a correctness baseline only for exercised invariants, not universal proof, full-load success, or cloud performance.

The pre-fix final 100k report is retained separately; all four cases passed admitted-write persistence/restart audits but failed to complete their requested loads. Authorized correctness fixes subsequently changed capacity lookup pages from 500 to the runtime's 100-bind limit; the regression requires batches of 100, 101, and 1,000 distinct entities to persist and query correctly through restart. Participant prepare replay now precedes mutable fact-state/capacity validation; coordinator retained outcomes precede busy admission; explicit boolean retry hints are honored with permanent quota errors distinguished from temporary pressure; post-commit pruning failures cannot fail a published commit. No global coordinator redesign, schema reinterpretation, or quota increase was made. The database still retains at most 100,000 transaction outcomes within seven days. The 100k two-fact case uses 50,000 calls, so it does not exercise that outcome limit; the 1M case uses 500,000 and must explicitly retest it during scale-up. Removing old results does not erase these source/test limitations.

The [corrected revision's final report](../../bench/write-path/results/2026-10-11T17-58-33-656Z-8f2fb877/final.json) records all four 100k cases passing admitted-write fact/index/transaction audits before and after restart. Regression checks passed 39 package tests (one skipped) and 6 harness tests. None of the cases completed the full input; this establishes a scoped correctness baseline, not a full-load success, universal proof, or throughput improvement. The [pre-fix final report](../../bench/write-path/results/2026-10-11T17-19-03-682Z-64195105/final.json) is retained for comparison. Raw/intermediate artifacts and console logs from both runs have been removed.

The cloud gate remains closed pending the remaining protocol/driver/deployment safety gates; the completed local matrix is correctness/debugging evidence only. Database rejections/errors are results, not reasons to resize, skip, or silently fix the system under test. Failed loads are not throughput winners; the local correctness gate checks complete delivery reporting and durable correctness of admitted writes rather than requiring error-free admission. Any future product fixes belong to a separately identified version.

## References

- [RFD0003: Cloudflare-native graph database](./RFD0003-cloudflare-native-graph-database.md)
- [RFD0004: Expandable, capacity-bounded sharding](./RFD0004-expandable-cloudflare-sharding.md)
- [Current client](../../poneglyph/src/client.ts), [package](../../poneglyph/package.json), and [limits](../../poneglyph/src/storage/constants.ts)
- [Existing corpus workload](../../examples/onepiece-load.ts), [local benchmark](../../poneglyph/tests/throughput-bench.test.ts), and [bounded operational evidence](./RFD0004-expandable-cloudflare-sharding.md#isolated-cloudflare-procedure-and-detailed-evidence)
- [Miniflare](https://developers.cloudflare.com/workers/testing/miniflare/) and [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [SQLite-backed DO storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [limits](https://developers.cloudflare.com/durable-objects/platform/limits/), and [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Worker service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) and [observability](https://developers.cloudflare.com/workers/observability/)
