import assert from "node:assert/strict";
import {parseReply} from "./response-evidence.js";
export type StageFact = Readonly<{index: number; source: string; entity: string; field: string; value: unknown; retraction: boolean}>;
export type ParticipantStage = Readonly<{status: "prepared" | "committed"; payloadHash: string; facts: readonly StageFact[]}>;
function uri(value: unknown): string {
  assert.ok(typeof value === "string" && value.length <= 1024 && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)); return value;
}
export function parseParticipantStage(input: unknown, graph: string, prefix: string, txId: string): ParticipantStage {
  const body = parseReply(input), identity = parseReply(body["identity"]);
  assert.equal(identity["graph_id"], graph); assert.equal(identity["prefix"], prefix); assert.equal(identity["role"], "leaf");
  const transactions = body["transactions"], facts = body["facts"];
  assert.ok(Array.isArray(transactions) && transactions.length === 1, "exact retained participant identity");
  assert.ok(Array.isArray(facts) && facts.length <= 1000);
  const transaction = parseReply(transactions[0]); assert.equal(transaction["tx_id"], txId);
  const status = transaction["status"], payloadHash = transaction["payload_hash"];
  assert.ok(status === "prepared" || status === "committed"); assert.ok(typeof payloadHash === "string" && /^[0-9a-f]{64}$/.test(payloadHash));
  const indices = new Set<number>();
  const parsed = facts.map(raw => {
    const row = parseReply(raw); assert.equal(row["tx_id"], txId);
    const index = row["tx_index"], retraction = row["retraction"], value = row["value_json"];
    assert.ok(typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && index < 1000 && !indices.has(index)); indices.add(index);
    assert.ok(retraction === 0 || retraction === 1); assert.equal(typeof value, "string");
    if (typeof value !== "string") throw new Error("invalid durable stage value");
    return Object.freeze({index, source: uri(row["source"]), entity: uri(row["entity"]), field: uri(row["field"]), value: JSON.parse(value), retraction: retraction === 1});
  });
  return Object.freeze({status, payloadHash, facts: Object.freeze(parsed)});
}
