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
