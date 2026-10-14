import assert from "node:assert/strict";
import {test} from "node:test";
import {ApplyGate, parseApplyGateStatus, parseApplyGateId} from "./worker/apply-gate.js";
const request = (id = "tx:partial") => new Request("https://shard.internal/_commit", {method: "POST", body: JSON.stringify({txId: id})});
async function waiting(gate: ApplyGate, hits = 1) {
  for (let i = 0; i < 100; i++) {const status = gate.status(); if (status.state === "waiting" && status.hits >= hits) return status; await new Promise(resolve => setTimeout(resolve, 1));}
  throw new Error("gate did not encounter native commit request");
}
test("pre-apply gate never claims or executes native SQL before explicit release", async () => {
  const gate = new ApplyGate(); gate.arm({txId: "tx:partial"}); let calls = 0;
  const pending = gate.intercept(request(), async () => {calls++; return Response.json({status: "committed"});});
  const status = await waiting(gate); assert.equal(calls, 0); assert.deepEqual(parseApplyGateStatus(status), status);
  const released = gate.release(); assert.ok(released.state === "released" && released.outcome === "released");
  await pending; assert.equal(calls, 1); gate.clear();
});
test("every duplicate request is held and clearing drains original work without replacement input", async () => {
  const gate = new ApplyGate(); gate.arm({txId: "tx:partial"}); let calls = 0;
  const invoke = async () => {calls++; return Response.json({status: "committed"});};
  const first = gate.intercept(request(), invoke), second = gate.intercept(request(), invoke);
  await waiting(gate, 2); assert.equal(calls, 0); gate.clear(); await Promise.all([first, second]); assert.equal(calls, 2);
  assert.deepEqual(gate.status(), {state: "idle"});
});
test("stale request parsing cannot activate a replacement arm with the same identity", async () => {
  const gate = new ApplyGate(); gate.arm({txId: "tx:partial"}); let calls = 0;
  const pending = gate.intercept(request(), async () => {calls++; return Response.json({status: "committed"});});
  gate.clear(); gate.arm({txId: "tx:partial"}); await pending; assert.equal(calls, 1); assert.deepEqual(gate.status(), {state: "armed", txId: "tx:partial"}); gate.clear();
});
test("wrong identity passes through; expiry is a failed fixture outcome rather than a success receipt", async () => {
  const gate = new ApplyGate(5); gate.arm({txId: "tx:partial"}); let calls = 0;
  await gate.intercept(request("tx:other"), async () => {calls++; return Response.json({status: "committed"});}); assert.equal(calls, 1);
  await gate.intercept(request(), async () => {calls++; return Response.json({status: "committed"});});
  const expired = gate.status(); assert.ok(expired.state === "released" && expired.outcome === "expired"); assert.equal(calls, 2); gate.clear();
  assert.throws(() => parseApplyGateId({txId: "bare"}));
  for (const input of [{state: "waiting", txId: "tx:partial", path: "/_atomic", hits: 1}, {state: "waiting", txId: "tx:partial", path: "/_commit", hits: 0}]) assert.throws(() => parseApplyGateStatus(input));
});
