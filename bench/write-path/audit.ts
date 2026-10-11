import { record, type Batch, type CallOutcome } from "./driver.js";
import type { LocalRuntime } from "./runtime.js";

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("audit rows must be an array");
  return value.map(record);
}
function count(value: unknown): number {
  const row = rows(value)[0];
  if (typeof row?.count !== "number") throw new Error("invalid audit count");
  return row.count;
}
function signature(source: unknown, entity: unknown, field: unknown, value: unknown, retraction: unknown) {
  return JSON.stringify([source, entity, field, value, Boolean(retraction)]);
}

export async function verify(runtime: LocalRuntime, batches: Batch[], outcomes: CallOutcome[]) {
  const plans = new Map(batches.map(batch => [batch.txId, batch]));
  const expected = new Map<string, Map<string, number>>();
  for (const batch of batches) {
    const multiset = new Map<string, number>();
    for (const fact of batch.facts) {
      const key = signature(fact.source, fact.entity, fact.field, fact.value, fact.retraction);
      multiset.set(key, (multiset.get(key) ?? 0) + 1);
    }
    expected.set(batch.txId, multiset);
  }
  const seenTransactions = new Map<string, number>();
  let facts = 0, active = 0, databaseBytes = 0;
  const pending = [""], visited = new Set<string>();
  while (pending.length) {
    const prefix = pending.pop()!;
    if (visited.has(prefix) || visited.size >= 4096) throw new Error("cyclic or excessive audit topology");
    visited.add(prefix);
    let after = 0;
    while (true) {
    const page = record(await runtime.audit(`shard?prefix=${prefix}&after=${after}`));
    const identity = rows(page.identity)[0];
    if (identity?.role === "router") {
      for (const key of ["child_zero_prefix", "child_one_prefix"]) {
        const child = identity[key];
        if (typeof child !== "string" || child.length <= prefix.length || !child.startsWith(prefix) || !/^[01]{1,256}$/.test(child)) throw new Error("invalid router child");
        pending.push(child);
      }
      break;
    }
    if (identity?.role !== "leaf") throw new Error("invalid audit leaf identity");
    if (after === 0) {
      if (count(page.missingValues) !== 0 || count(page.orphanValues) !== 0 || count(page.mismatchedValues) !== 0) throw new Error("fact/value index inconsistency");
      const current = count(page.active);
      active += current;
      if (count(page.values) !== current) throw new Error("scalar corpus value index count mismatch");
      if (typeof page.databaseBytes === "number") databaseBytes += page.databaseBytes;
      for (const status of rows(page.statuses)) if (status.status === "prepared" && status.count !== 0) throw new Error("unresolved participant transaction");
    }
    const entries = rows(page.facts);
    if (!entries.length) break;
    for (const row of entries) {
      if (typeof row.tx_id !== "string" || typeof row.value_json !== "string" || typeof row.ordinal !== "number") throw new Error("invalid fact audit row");
      if (!plans.has(row.tx_id)) throw new Error(`unexpected transaction ${row.tx_id}`);
      const key = signature(row.source, row.entity, row.field, JSON.parse(row.value_json), row.retraction);
      const remaining = expected.get(row.tx_id)!;
      const n = remaining.get(key) ?? 0;
      if (!n) throw new Error(`extra or mismatched fact in ${row.tx_id}`);
      remaining.set(key, n - 1); facts++; after = row.ordinal;
      seenTransactions.set(row.tx_id, (seenTransactions.get(row.tx_id) ?? 0) + 1);
    }
    }
  }
  for (const [txId] of seenTransactions) {
    if ([...expected.get(txId)!.values()].some(n => n !== 0)) throw new Error(`partial transaction ${txId}`);
  }
  for (const outcome of outcomes) {
    if (outcome.kind === "committed" && seenTransactions.get(outcome.txId) !== outcome.facts) throw new Error(`acknowledged write missing: ${outcome.txId}`);
    if (outcome.kind === "rejected" && seenTransactions.has(outcome.txId)) throw new Error(`rejected write persisted: ${outcome.txId}`);
  }
  const coordinator = record(await runtime.audit("coordinator"));
  if (coordinator.visibilityScope === "subtree-vector") {
    for (const outcome of outcomes.filter(o => o.kind !== "committed")) {
      const states = rows(await runtime.audit(`transaction?txId=${encodeURIComponent(outcome.txId)}`));
      for (const state of states) if (!["complete", "aborted"].includes(String(state.phase))) throw new Error("unresolved unacknowledged transaction coordinator");
    }
  }
  for (const phase of rows(coordinator.phases)) if (!["complete", "aborted"].includes(String(phase.phase))) throw new Error("unresolved coordinator transaction");
  // Scalar corpus facts have one current value-index entry each. Full row membership is
  // checked in the log; current unique tuples are checked against the active projection.
  const activeTuples = new Set<string>();
  for (const txId of seenTransactions.keys()) for (const fact of plans.get(txId)!.facts) {
    if (fact.retraction) throw new Error("corpus audit does not model retractions; use dedicated protocol tests");
    activeTuples.add(signature(fact.source, fact.entity, fact.field, fact.value, false));
  }
  if (active !== activeTuples.size) throw new Error(`active tuple mismatch ${active} != ${activeTuples.size}`);
  return { valid: true, persistedFacts: facts, persistedTransactions: seenTransactions.size, activeTuples: active,
    reconciledUnacknowledgedTransactions: outcomes.filter(x => x.kind === "unknown" && seenTransactions.has(x.txId)).length,
    uncommittedAtQuiescentAudit: outcomes.filter(x => x.kind === "unknown" && !seenTransactions.has(x.txId)).length,
    databaseBytes, coordinator };
}
