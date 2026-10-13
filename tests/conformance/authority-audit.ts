import assert from "node:assert/strict";
import type {Session} from "./session.js";
import {parseInspectionPage} from "./inspection-page.js";
import {parseAuthorityActors, parseCoordinatorAuthority, parseShardAuthority, type AuthorityActor, type Terminal} from "./authority-evidence.js";
import {transactionDigest} from "./transaction-digest.js";
import {parseParticipantWitness, verifyOwnerWitness} from "./owner-witness.js";
import {correctnessBudgets} from "./contract.js";
type AuditRequest = (path: string, parameters: Record<string, string>, body?: object) => Promise<unknown>;

async function recordedRequest(s: Session): Promise<AuditRequest> {
  const database = s.runtime.database;
  return async (path, parameters, body) => {
    const url = new URL(`https://audit.internal/__e2e/${path}`);
    for (const [key, value] of Object.entries({graph: s.graph, ...parameters})) url.searchParams.set(key, value);
    const response = await database.fetch(url, {method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined,
      headers: {authorization: `Bearer ${s.runtime.token}`}, signal: AbortSignal.timeout(correctnessBudgets.requestMs)});
    const evidence: unknown = await response.json();
    s.outcomes.push({control: "read-only-authority", path, parameters, status: response.status, evidence});
    assert.equal(response.status, 200, `authority inspection ${path}`); return evidence;
  };
}
async function collectActors(s: Session, request: AuditRequest) {
  const actors = new Map<string, AuthorityActor>(), ids = [...new Set([...s.submittedTransactionIds, ...s.model.transactions.keys()])];
  for (let start = 0; start < Math.max(1, ids.length); start += 128) {
    for (const actor of parseAuthorityActors(await request("authority-actors", {}, {txIds: ids.slice(start, start + 128)}))) {
      const prior = actors.get(actor.name); if (prior) assert.equal(prior.role, actor.role, "stable authority role");
      actors.set(actor.name, actor);
    }
  }
  return [...actors.values()];
}
async function inspectCanonical(graph: string, actors: readonly AuthorityActor[], request: AuditRequest) {
  const canonical = new Map<string, Terminal>(), candidate = actors.some(actor => actor.role === "owner");
  for (const actor of actors) {
    let after = 0, pages = 0, seenRows = 0;
    while (true) {
      assert.ok(++pages <= Math.ceil(correctnessBudgets.authorityRowsPerActor / correctnessBudgets.authorityPageRows) + 1, "finite authority page budget");
      const rows = parseCoordinatorAuthority(await request("coordinator-authority", {name: actor.name, role: actor.role, after: String(after)}), after);
      seenRows += rows.length; assert.ok(seenRows <= correctnessBudgets.authorityRowsPerActor, "bounded retained authority inspection");
      for (const row of rows) {
        if (actor.role === "ledger") assert.equal(row.graphId, graph, "canonical ledger graph binding");
        if (actor.role === "ledger" || (!candidate && actor.role === "graph")) {
          assert.ok(!canonical.has(row.txId), "one canonical retained decision authority per identity"); canonical.set(row.txId, row);
        }
      }
      if (!rows.length) break; after = rows.at(-1)!.cursor;
    }
  }
  return canonical;
}
function verifyAcknowledged(s: Session, canonical: ReadonlyMap<string, Terminal>) {
  for (const [txId, facts] of s.model.transactions) {
    const terminal = canonical.get(txId); assert.ok(terminal, `acknowledged canonical decision ${txId}`);
    assert.equal(terminal.phase, "complete", "acknowledged outcome is committed, never admitted/aborted");
    assert.equal(terminal.payloadHash, transactionDigest(txId, facts), "independent exact retained payload identity");
    assert.equal(terminal.commitSeq, s.acknowledgedSequences.get(txId), "retained sequence matches the caller's exact receipt, not graph-global ordering");
  }
  for (const [txId, terminal] of canonical) if (terminal.phase === "complete") assert.ok(s.model.transactions.has(txId), `committed operation not reconciled with caller history: ${txId}`);
}
async function inspectParticipants(graph: string, ownerDepth: number, canonical: ReadonlyMap<string, Terminal>, request: AuditRequest) {
  const queue = [""], visited = new Set<string>(), ownerSnapshots = new Map<string, unknown>();
  while (queue.length) {
    const prefix = queue.shift()!; assert.ok(!visited.has(prefix) && visited.size < 511, "bounded authority directory"); visited.add(prefix);
    const page = parseInspectionPage(await request("inspect", {prefix, table: "fact_log", after: "0"}), prefix, 0);
    if (page.kind === "router") queue.push(...page.children);
    if (prefix.length < ownerDepth) continue;
    let after = 0, pages = 0, seenRows = 0;
    while (true) {
      assert.ok(++pages <= Math.ceil(correctnessBudgets.authorityRowsPerActor / correctnessBudgets.authorityPageRows) + 1, "finite participant authority pages");
      const rows = parseShardAuthority(await request("shard-authority", {prefix, after: String(after)}), graph, prefix, after);
      seenRows += rows.length; assert.ok(seenRows <= correctnessBudgets.authorityRowsPerActor, "bounded participant outcomes");
      for (const row of rows) {
        const witness = parseParticipantWitness(row, graph, prefix, ownerDepth), key = JSON.stringify([witness.ownerPrefix, witness.txId]);
        const decision = canonical.get(witness.txId); assert.ok(decision, "participant outcome has its canonical decision");
        assert.equal(witness.payloadHash, decision.payloadHash, "participant digest binds the canonical payload");
        assert.equal(witness.decision, decision.phase === "complete" ? "committed" : "aborted", "participant decision agrees with its exact canonical authority");
        if (!ownerSnapshots.has(key)) ownerSnapshots.set(key, await request("owner-witness", {prefix: witness.ownerPrefix, txId: witness.txId}));
        // Validate every tuple, even cached-release=1; a later ticket/watermark
        // and an uncopied pruning flag cannot establish this identity's outcome.
        verifyOwnerWitness(ownerSnapshots.get(key), witness);
      }
      if (!rows.length) break; after = rows.at(-1)!.cursor;
    }
  }
}
export async function auditAuthorities(s: Session) {
  const request = await recordedRequest(s), actors = await collectActors(s, request);
  const canonical = await inspectCanonical(s.graph, actors, request);
  verifyAcknowledged(s, canonical);
  await inspectParticipants(s.graph, actors.some(actor => actor.role === "owner") ? 4 : 0, canonical, request);
}
