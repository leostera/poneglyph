import assert from "node:assert/strict";
import {test} from "node:test";
import {setImmediate} from "node:timers/promises";
import {WriteBarrier, parseBarrierConfig, parseBarrierStatus} from "./worker/write-barrier.js";
const config = {phase: "prepared" as const, txId: "tx:phase"};
const request = (path = "/_prepare", txId = "tx:phase") => new Request(`https://native${path}`, {method: "POST", body: JSON.stringify({txId})});
const reply = () => Promise.resolve(Response.json({status: "prepared"}));
async function waiting(barrier: WriteBarrier, hits = 1) {
  for (let poll = 0; poll < 200; poll++) {
    const status = barrier.status();
    if (status.state === "waiting" && status.hits >= hits) return status;
    await setImmediate();
  }
  throw new Error("unit barrier did not reach waiting state");
}
test("barrier boundary returns precise states and rejects malformed controls", () => {
  assert.deepEqual(parseBarrierConfig(config), config);
  assert.deepEqual(parseBarrierStatus({state: "idle"}), {state: "idle"});
  for (const input of [null, [], {phase: "none", txId: "tx:phase"}, {...config, txId: "bare"}]) assert.throws(() => parseBarrierConfig(input));
  for (const input of [{state: "unknown", config}, {state: "waiting", config, path: "/_commit", nativeStatus: 200, hits: 1}, {state: "waiting", config, path: "/_prepare", nativeStatus: 200, hits: 0}]) assert.throws(() => parseBarrierStatus(input));
});
test("idle/unmatched requests retain their native response", async () => {
  const barrier = new WriteBarrier();
  const response = Response.json({status: "prepared"});
  assert.equal(await barrier.intercept(request(), async () => response), response);
  barrier.arm(config);
  assert.equal(await barrier.intercept(request("/_prepare", "tx:other"), async () => response), response);
  assert.equal(await barrier.intercept(request("/_commit"), async () => response), response);
  assert.equal(barrier.status().state, "armed"); barrier.clear();
});
test("real native work finishes before its reply waits; release retains response", async () => {
  const barrier = new WriteBarrier(); barrier.arm(config);
  let invoked = false, returned = false;
  const response = Response.json({status: "prepared"});
  const pending = barrier.intercept(request(), async () => {invoked = true; return response;}).then(value => {returned = true; return value;});
  const status = await waiting(barrier);
  assert.ok(invoked); assert.equal(returned, false); assert.deepEqual(parseBarrierStatus(status), status);
  assert.equal(barrier.release().state, "released");
  assert.equal(await pending, response); barrier.clear();
});
test("duplicate native replies cannot bypass the same barrier", async () => {
  const barrier = new WriteBarrier(); barrier.arm(config);
  const first = barrier.intercept(request(), reply); await waiting(barrier);
  let secondReturned = false;
  const second = barrier.intercept(request(), reply).then(value => {secondReturned = true; return value;});
  await waiting(barrier, 2); assert.equal(secondReturned, false);
  barrier.release(); await first; await second; barrier.clear();
});
test("clear drains pending requests and forbids implicit rearming", async () => {
  const barrier = new WriteBarrier(); barrier.arm(config);
  assert.throws(() => barrier.arm(config)); assert.throws(() => barrier.release());
  const pending = barrier.intercept(request(), reply); await waiting(barrier);
  barrier.clear(); await pending; assert.equal(barrier.status().state, "idle");
});
test("failed native phases are reported, never fabricated as successful hits", async () => {
  const barrier = new WriteBarrier(); barrier.arm(config);
  const response = Response.json({error: "native failure"}, {status: 503});
  assert.equal(await barrier.intercept(request(), async () => response), response);
  assert.equal(barrier.status().state, "rejected"); barrier.clear();
});
test("safety expiry is a distinct failed fixture outcome", async () => {
  const barrier = new WriteBarrier(5); barrier.arm(config);
  await barrier.intercept(request(), reply);
  const status = barrier.status();
  assert.ok(status.state === "released" && status.outcome === "expired"); barrier.clear();
});
test("clearing during native work cannot activate a replacement barrier", async () => {
  const barrier = new WriteBarrier(); barrier.arm(config);
  let finish!: (response: Response) => void;
  let begin!: () => void;
  const began = new Promise<void>(resolve => {begin = resolve;});
  const native = new Promise<Response>(resolve => {finish = resolve;});
  const pending = barrier.intercept(request(), () => {begin(); return native;});
  await began; barrier.clear(); barrier.arm(config);
  finish(Response.json({status: "prepared"})); await pending;
  assert.equal(barrier.status().state, "armed"); barrier.clear();
});
