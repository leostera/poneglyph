import { record } from "./driver.js";
import { AuditLedger, tupleHash } from "./ledger.js";
import type { LocalRuntime } from "./runtime.js";

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("expected audit rows");
  return value.map(record);
}
function count(value: unknown): number {
  const row = rows(value)[0];
  if (typeof row?.count !== "number") throw new Error("invalid audit count");
  return row.count;
}
export async function verifyStream(runtime: LocalRuntime, ledger: AuditLedger) {
  ledger.beginAudit();
  const prefixes = [""];
  const seen = new Set<string>();
  let active = 0, databaseBytes = 0, leaves = 0, auditedFacts = 0, maxCommitSeq = 0;
  while (prefixes.length) {
    const prefix = prefixes.pop()!;
    if (seen.has(prefix) || seen.size >= 4096) throw new Error("cyclic or excessive audit topology");
    seen.add(prefix);
    let after = 0;
    while (true) {
      const page = record(await runtime.audit(`shard?prefix=${prefix}&after=${after}`));
      const identity = rows(page.identity)[0];
      if (identity?.role === "router") {
        for (const key of ["child_zero_prefix", "child_one_prefix"]) {
          const child = identity[key];
          if (typeof child !== "string" || child.length <= prefix.length || !child.startsWith(prefix) || !/^[01]{1,256}$/.test(child)) throw new Error("invalid router child");
          prefixes.push(child);
        }
        break;
      }
      if (identity?.role !== "leaf") throw new Error("invalid leaf identity");
      if (after === 0) {
        leaves++;
        for (const key of ["missingValues", "orphanValues", "mismatchedValues", "mismatchedFacts", "mismatchedDatalog"]) {
          if (count(page[key])) throw new Error(`fact/value index inconsistency: ${key}`);
        }
        const max = rows(page.maxCommitSeq)[0]?.value;
        if (typeof max !== "number") throw new Error("invalid maximum commit sequence");
        maxCommitSeq = Math.max(maxCommitSeq, max);
        const current = count(page.active);
        if (count(page.values) !== current) throw new Error("scalar value-index count mismatch");
        active += current;
        if (typeof page.databaseBytes === "number") databaseBytes += page.databaseBytes;
        for (const status of rows(page.statuses)) if (status.status === "prepared") throw new Error("unresolved participant");
      }
      const entries = rows(page.facts);
      if (!entries.length) break;
      for (const row of entries) {
        if (typeof row.tx_id !== "string" || typeof row.value_json !== "string" || typeof row.ordinal !== "number") throw new Error("invalid persisted fact row");
        ledger.matchFact(row.tx_id, tupleHash(row.source, row.entity, row.field, JSON.parse(row.value_json), row.retraction));
        after = row.ordinal; auditedFacts++;
      }
      if (auditedFacts % 51200 === 0) console.log(`audit: ${auditedFacts} persisted facts checked`);
    }
  }
  const totals = ledger.finishAudit();
  if (totals.activeTuples !== active) throw new Error(`active tuple mismatch ${active} != ${totals.activeTuples}`);
  const coordinator = record(await runtime.audit("coordinator"));
  for (const phase of rows(coordinator.phases)) if (!["complete", "aborted"].includes(String(phase.phase))) throw new Error("unresolved coordinator transaction");
  if (coordinator.visibilityScope === "subtree-vector") {
    // Owner registries cover admitted writes. Also inspect every caller-unknown
    // or rejected ID so an unclaimed transaction intent cannot evade the audit.
    const ids = ledger.db.prepare("SELECT server_tx_id FROM outcomes WHERE kind != 'committed' AND server_tx_id IS NOT NULL").all();
    for (let offset = 0; offset < ids.length; offset += 16) await Promise.all(ids.slice(offset, offset + 16).map(async id => {
      if (typeof id.server_tx_id !== "string") throw new Error("invalid audited transaction ID");
      const states = rows(await runtime.audit(`transaction?txId=${encodeURIComponent(id.server_tx_id)}`));
      for (const state of states) if (!["complete", "aborted"].includes(String(state.phase))) throw new Error("unresolved unacknowledged transaction coordinator");
    }));
  }
  const visible = rows(coordinator.state)[0]?.visible_seq;
  if (typeof visible !== "number" || visible < maxCommitSeq) throw new Error("persisted facts beyond the coordinator visibility watermark");
  return { valid: true, ...totals, leaves, directoryNodes: seen.size, databaseBytes, coordinator };
}
