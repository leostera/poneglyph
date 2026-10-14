import assert from "node:assert/strict";
import {test} from "node:test";
import {parseParticipantStage} from "./participant-stage.js";
const hash = "a".repeat(64);
function stage(status = "prepared", facts: object[] = []) {return {identity: {graph_id: "test", prefix: "01", role: "leaf"}, transactions: [{tx_id: "tx:partial", payload_hash: hash, status}], facts};}
const row = {tx_id: "tx:partial", tx_index: 0, source: "agent:a", entity: "test:e", field: "test:value", value_json: '{"type":"text","value":"x"}', retraction: 0};
test("participant stage carries actual retained identity and exact typed append-only rows", () => {
  assert.deepEqual(parseParticipantStage(stage(), "test", "01", "tx:partial"), {status: "prepared", payloadHash: hash, facts: []});
  assert.deepEqual(parseParticipantStage(stage("committed", [row]), "test", "01", "tx:partial").facts, [{index: 0, source: "agent:a", entity: "test:e", field: "test:value", value: {type: "text", value: "x"}, retraction: false}]);
});
test("wrong graph/prefix/role/identity, missing/duplicate rows and malformed fact scalars fail closed", () => {
  for (const identity of [{graph_id: "wrong", prefix: "01", role: "leaf"}, {graph_id: "test", prefix: "10", role: "leaf"}, {graph_id: "test", prefix: "01", role: "router"}]) assert.throws(() => parseParticipantStage({...stage(), identity}, "test", "01", "tx:partial"));
  for (const transactions of [[], [...stage().transactions, ...stage().transactions], [{...stage().transactions[0], tx_id: "tx:other"}], [{...stage().transactions[0], payload_hash: "wrong"}], [{...stage().transactions[0], status: "cancelled"}]]) assert.throws(() => parseParticipantStage({...stage(), transactions}, "test", "01", "tx:partial"));
  for (const facts of [[row, row], [{...row, retraction: "0"}], [{...row, tx_index: -1}], [{...row, tx_id: "tx:other"}], [{...row, value_json: "not json"}], [{...row, source: "bare"}]]) assert.throws(() => parseParticipantStage(stage("committed", facts), "test", "01", "tx:partial"));
});
