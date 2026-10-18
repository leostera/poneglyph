# Poneglyph formal checks

The authoritative protocol and validation scope is in [RFD0004](../docs/rfds/RFD0004-expandable-cloudflare-sharding.md#formal-model-and-validation). These checks do not prove hosted implementation correctness or performance.

## Write-protocol modeling work (2026-10-18)

Keep three layers distinct:

- **Implemented baseline:** `ReadVectorRecovery` explores gated multi-owner apply/publication/recovery after an irrevocable decision; `ReadHeadPublication` explores replicated freshness and membership. Their omissions include actual storage/RPC scheduling, admission/abort, full topology integration and implementation refinement.
- **Proposed conservative change:** owner-local, independently atomic microbatches interleaved with multi-owner transactions, retaining canonical atomic vector publication. Model mixed success/abort, bounded admission, duplicate/lost replies, exact epoch fencing, incremental projections and publication/release recovery before implementing this path.
- **Deferred redesign:** distributed publication without the canonical authority. No existing result establishes its correctness or performance.

Build a shared semantic publication core with an inductive safety proof, then check a numeric-revision batch protocol against that core. A core proof alone does not prove the concrete revision/epoch machinery; record concrete TLC checks and unproved refinement obligations separately. Model commutative independent assertions first: arbitrary conditional updates, predicate locking, entity quotas, dynamic batching and history pruning require additional models.

### Shared write-publication core

`WritePublicationCore.tla` specifies immutable transaction identities, disjoint durable commit/abort decisions, idempotent participant effects, atomic group publication and successful acknowledgements. `WritePublicationCoreProofs.tla` proves `CoreSpec => []CoreSafety` through an explicit inductive invariant: no aborted effects, transaction-complete published visibility and no successful acknowledgement before publication. The proof is parameterized by arbitrary owner/transaction sets and nonempty immutable participant sets; it has no TLC cardinality bound.

Initial verification discharged **27 TLAPS obligations**, explored **288 distinct TLC states** (6,309 generated), and rejected proof attempts after three deliberate weakenings: conflicting durable decisions, publication before effects, and acknowledgement before publication. This is a semantic core proof, not a proof of numeric revisions, physical exactly-once writes, queues, epochs, predicates, liveness, the TypeScript implementation or latency. The concrete batch model must connect its numeric cuts to this core separately.

```sh
TLAPM=/path/to/tlapm
"$TLAPM" --strict --nofp --cache-dir /tmp/write-core-proofs specs/WritePublicationCoreProofs.tla
# Run TLC on temporary copies, with WritePublicationCoreMC.cfg and WritePublicationCoreMC.tla.
```

## TLC: finite-state exploration

With a locally installed JDK and a verified `tla2tools.jar`:

```sh
TLA2TOOLS_JAR=/path/to/tla2tools.jar ./specs/check-read-vector-publication.sh
TLA2TOOLS_JAR=/path/to/tla2tools.jar ./specs/check-read-head-publication.sh
```

The first script translates temporary copies of the PlusCal publication/recovery models. The second checks read-head membership/publication/recovery and deliberate negative controls. Consult the RFD and retained result directories for exact historical tool digests and bounds; rolling upstream release URLs alone are not pins.

## TLAPS: deductive proofs

The executable is **`tlapm`**, the TLA+ Proof Manager in [TLAPS](https://github.com/tlaplus/tlapm). It complements TLC; it does not turn passing finite instances into unbounded theorems. Upstream [documentation](https://proofs.tlapl.us/) describes proof syntax and backend trust.

Install TLAPS locally from its official releases or build instructions. Do not commit binaries. Run:

```sh
TLAPM=/path/to/tlapm ./specs/check-tlaps.sh
# Optional retained output directory:
TLAPM=/path/to/tlapm TLAPS_EVIDENCE_DIR=/tmp/poneglyph-tlaps ./specs/check-tlaps.sh
```

The runner requires Python 3, uses strict checking and fresh fingerprints, and fails on unproved obligations. It runs outside the repository in temporary directories. No benchmark, cloud call, default test hook, or deployment is started.

### Current proof coverage

`ReadHeadKernelProofs.tla` imports the actual operators of `ReadHeadPublication.tla`. Three local lemmas establish:

1. With activation fencing enabled, a mismatched generation cannot activate a head.
2. Mode `retired` cannot be revived by any modeled head command operator.
3. A frozen head's permitted projection is current **if the canonical version is one of its committed/prepared pair**.

Head counters range over unbounded `Nat`. The third premise still needs a global inductive proof. The current six discharged obligations are **not** `Spec => []Safety`, a liveness proof, an implementation refinement, or any proof of the proposed batched-write algorithm. Three weakened-model controls must fail their intended lemma; an unsuccessful proof attempt is not itself a certified counterexample.

The runner currently selects the SMT backend. This trusts TLAPS translation and the configured SMT solver; it does not claim Isabelle certificate rechecking. The successful initial run used bundled Z3 4.8.9. Preserve backend/tool versions when retaining evidence.

### Verified initial tool asset

The initial run used upstream `1.6.0-pre` (rolling), `tlapm --version` **`901ae51`**, on macOS arm64:

- Asset: `tlapm-1.6.0-pre-arm64-darwin.tar.gz`
- URL: https://github.com/tlaplus/tlapm/releases/download/1.6.0-pre/tlapm-1.6.0-pre-arm64-darwin.tar.gz
- GitHub asset ID: `647843946`, updated `2026-10-16T16:03:41Z`.
- Verified SHA-256: `d84177fd0984e9e694c9daba2f9872a59d9c2b57741923c86ba569335f23b039`.

Verify the digest before extracting/running a downloaded tool. If the rolling asset changes, do not treat it as this toolchain; record and assess the new version explicitly. No global installation is performed by the check script. Initial logs, exact source copies and hashes are in `results/read-head-kernel-tlaps-2026-10-18/`.
