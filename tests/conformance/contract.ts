// Shared required coverage, not a capability exemption or a test selector.
// Every family remains mandatory on A/B1/C–K. Partial foundations cannot certify
// a tier, regardless of how many currently executable cases are green.
export const requiredCoverage = Object.freeze([
  {family: "facts-values-projections", remaining: ["complete tiny ordered histories and metamorphic permutations"]},
  {family: "queries-access-algebra", remaining: ["joins/reverse/negative reads through every recovery/topology/concurrency phase"]},
  {family: "public-client-boundary", remaining: ["all client write entrypoints, generated IDs, malformed receipts and abort-before/during-send"]},
  {family: "identity-concurrency", remaining: ["overlapping/disjoint entity and source histories, retraction races, tickets and bounded legal-history enumeration"]},
  {family: "write-failures-recovery", remaining: ["before admission, reservation, prepare, decision, local witness, participant application, publication/release and recovery interruption"]},
  {family: "routing-migration", remaining: ["copy/page digest replay, abrupt interruption during migration/cutover, stale/retired generations/epochs and pinned work/leases"]},
  {family: "native-lifecycle", remaining: ["actual abrupt process-group crash and actor eviction distinct from quiescent restart"]},
  {family: "limits-maintenance", remaining: ["below/at/above all declared bounds, synthetic expiry/quota/pinning, explicit bounded recovery"]},
  {family: "stateful-100k", remaining: ["32 fixed stateful seeds, streamed 100k append/churn, exhaustive bounded public reads and durable reconciliation"]},
]);
export const correctnessBudgets = Object.freeze({
  requestMs: 30_000, writeAttempts: 16, retryBackoffMs: 5,
  phaseObservationPolls: 128, phaseObservationDelayMs: 5,
  controlRequestMs: 2_000, inFlightReadMs: 2_000, replyBarrierSafetyMs: 10_000,
  recoveryAttempts: 16, // Original graph/ID/payload only; unknown is not abort.
  authorityRowsPerActor: 100_000, authorityPageRows: 128, // Existing retention bound; read-only paging, never pruning.
});
// Stable, recorded inputs for the next tier; declaring them is not execution.
// uint32 seeds are numeric PRNG states, never backend routing/expected data.
export const statefulSeeds: readonly number[] = Object.freeze(Array.from({length: 32}, (_, index) =>
  (0x6d2b79f5 + index * 0x9e3779b9) >>> 0));
export const smallTierComplete = false;
