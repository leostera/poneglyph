import assert from "node:assert/strict";
import {parseReply} from "./response-evidence.js";
import type {SqlRow} from "./inspection-page.js";
export type ParticipantWitness = Readonly<{
  txId: string; payloadHash: string; decision: "committed" | "aborted";
  ownerPrefix: string; commitSeq: number; directoryEpoch: number; identityTimeMs: number;
}>;
function integer(input: unknown, minimum: number, label: string): number {
  assert.ok(typeof input === "number" && Number.isSafeInteger(input) && input >= minimum, label); return input;
}
export function parseParticipantWitness(row: SqlRow, graph: string, prefix: string, ownerDepth: number): ParticipantWitness {
  const status = row["status"], kind = row["decision_kind"];
  assert.ok(status === "committed" || status === "cancelled", "participant terminal decision");
  assert.ok(kind === "atomic" || kind === "distributed", "participant decision authority kind");
  const txId = row["tx_id"], payloadHash = row["payload_hash"];
  assert.ok(typeof txId === "string" && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(txId), "participant URI identity");
  assert.ok(typeof payloadHash === "string" && /^[0-9a-f]{64}$/.test(payloadHash), "participant exact payload digest");
  assert.ok(row["owner_released"] === 0 || row["owner_released"] === 1, "cached proof is a SQL boolean, not actual publication authority");
  const identityTimeMs = integer(row["created_at_ms"], 1, "participant identity time");
  const raw = kind === "atomic" ? {graphId: graph, shardPrefix: prefix, shardGeneration: row["atomic_generation"],
    directoryEpoch: row["atomic_directory_epoch"], txId, payloadHash, commitSeq: row["atomic_commit_seq"],
    statementTimeMs: row["atomic_statement_ms"], identityTimeMs} : parseReply(JSON.parse(String(row["decision_context_json"])));
  assert.equal(raw["graphId"], graph, "participant graph scope");
  assert.equal(raw["txId"], txId); assert.equal(raw["payloadHash"], payloadHash); assert.equal(raw["identityTimeMs"], identityTimeMs);
  const authorityPrefix = raw["shardPrefix"];
  assert.ok(typeof authorityPrefix === "string" && /^[01]*$/.test(authorityPrefix) && authorityPrefix.length >= ownerDepth && authorityPrefix.length <= 256, "participant physical authority prefix");
  const ownerPrefix = prefix.slice(0, ownerDepth);
  assert.equal(authorityPrefix.slice(0, ownerDepth), ownerPrefix, "migration preserves the original owner authority");
  integer(raw["shardGeneration"], 0, "participant authority generation"); integer(raw["statementTimeMs"], 1, "participant statement time");
  return Object.freeze({txId, payloadHash, decision: status === "committed" ? "committed" : "aborted", ownerPrefix,
    commitSeq: integer(raw["commitSeq"], 1, "participant owner sequence"), directoryEpoch: integer(raw["directoryEpoch"], 0, "participant directory epoch"), identityTimeMs});
}
export function verifyOwnerWitness(input: unknown, expected: ParticipantWitness) {
  const body = parseReply(input), state = parseReply(body["state"]), rows = body["rows"];
  assert.equal(body["locks"], 0, "owner actually released this identity's entity locks");
  assert.ok(Array.isArray(rows) && rows.length === 1, "retained exact owner reservation witness, not an inferred watermark");
  const row = parseReply(rows[0]);
  assert.equal(row["tx_id"], expected.txId); assert.equal(row["payload_hash"], expected.payloadHash);
  assert.equal(row["ticket_seq"], expected.commitSeq); assert.equal(row["directory_epoch"], expected.directoryEpoch);
  assert.equal(row["created_at_ms"], expected.identityTimeMs);
  assert.equal(row["phase"], expected.decision === "committed" ? "complete" : "aborted");
  if (expected.decision === "committed") {
    assert.equal(row["commit_seq"], expected.commitSeq, "exact owner publication, not another transaction's completion");
    assert.ok(integer(state["visible_seq"], 0, "owner visibility") >= expected.commitSeq, "own published visibility covers this committed reservation");
  }
}
