import assert from "node:assert/strict";
import {parseReply} from "./response-evidence.js";
import {parseInspectionPage} from "./inspection-page.js";
export type AuthorityActor = Readonly<{name: string; role: "graph" | "owner" | "ledger"}>;
export type Terminal = Readonly<{cursor: number; txId: string; phase: "complete" | "aborted"; payloadHash: string; commitSeq: number; graphId: string | null}>;
const countNames = ["pendingGraph", "pendingCandidate", "pendingReservations", "locks", "pendingTopology", "activeLeases", "invalidPublications"] as const;
export function parseAuthorityActors(input: unknown): readonly AuthorityActor[] {
  assert.ok(Array.isArray(input) && input.length > 0 && input.length <= 145, "bounded authority actor list");
  const actors: AuthorityActor[] = [], names = new Set<string>();
  for (const raw of input) {
    const row = parseReply(raw), name = row["name"], role = row["role"];
    assert.ok(typeof name === "string" && name.length > 0 && !names.has(name), "unique authority identity");
    assert.ok(role === "graph" || role === "owner" || role === "ledger", "known authority role");
    names.add(name); actors.push(Object.freeze({name, role}));
  }
  return actors;
}
export function parseCoordinatorAuthority(input: unknown, after: number) {
  const body = parseReply(input), state = parseReply(body["state"]), counts = parseReply(body["counts"]);
  for (const field of ["writer_tx_id", "topology_op_id"]) assert.equal(state[field], null, `quiescent authority ${field}`);
  assert.deepEqual(Object.keys(counts).sort(), [...countNames].sort(), "complete mandatory authority counters");
  for (const name of countNames) {
    const value = counts[name]; assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, `SQL authority counter ${name}`);
    assert.equal(value, 0, `unresolved authority obligation ${name}`);
  }
  const page = parseInspectionPage({children: [], rows: body["rows"]}, "", after);
  assert.equal(page.kind, "leaf"); if (page.kind !== "leaf") throw new Error("authority row page cannot route");
  const rows: Terminal[] = page.rows.map(row => {
    const txId = row["tx_id"], phase = row["phase"], payloadHash = row["payload_hash"], commitSeq = row["commit_seq"], graphId = row["graph_id"];
    assert.ok(typeof txId === "string" && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(txId), "terminal URI identity");
    assert.ok(phase === "complete" || phase === "aborted", "terminal authority phase, not admission");
    assert.ok(typeof payloadHash === "string" && /^[0-9a-f]{64}$/.test(payloadHash), "terminal canonical payload digest");
    assert.ok(typeof commitSeq === "number" && Number.isSafeInteger(commitSeq) && commitSeq >= (phase === "complete" ? 1 : 0), "terminal authority sequence");
    assert.ok(graphId === null || typeof graphId === "string", "terminal graph binding");
    return Object.freeze({cursor: row.cursor, txId, phase, payloadHash, commitSeq, graphId});
  });
  return rows;
}
export function parseShardAuthority(input: unknown, graph: string, prefix: string, after: number) {
  const body = parseReply(input);
  assert.deepEqual(Object.keys(body).sort(), ["cachedProofPending", "identity", "prepared", "rows", "unpublished"], "complete participant authority evidence");
  for (const name of ["prepared", "unpublished", "cachedProofPending"]) {
    const value = body[name]; assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, `SQL participant counter ${name}`);
    if (name !== "cachedProofPending") assert.equal(value, 0, `unresolved participant obligation ${name}`);
  }
  const page = parseInspectionPage({children: [], rows: body["rows"]}, prefix, after);
  assert.equal(page.kind, "leaf"); if (page.kind !== "leaf") throw new Error("participant authority cannot route");
  if (body["identity"] !== null) {
    const identity = parseReply(body["identity"]); assert.equal(identity["graph_id"], graph); assert.equal(identity["prefix"], prefix);
  } else assert.equal(page.rows.length, 0, "outcomes require an actual shard identity");
  return page.rows;
}
