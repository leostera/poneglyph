import assert from "node:assert/strict";
import {test} from "node:test";
import {parseReply, errorEvidence} from "./response-evidence.js";

test("public reply parsing rejects non-object JSON instead of unchecked casts", () => {
  for (const input of [null, [], 0, true, "reply"]) assert.throws(() => parseReply(input));
  const reply = {rows: []}; assert.equal(parseReply(reply), reply);
});
test("uncertain transport diagnostics preserve native code, cause, stack and name", () => {
  const cause = Object.assign(new Error("connection closed"), {code: "TEST_CLOSED"});
  const error = new TypeError("fetch failed", {cause});
  const evidence = errorEvidence(error);
  assert.equal(evidence.name, "TypeError"); assert.equal(evidence.message, "fetch failed");
  assert.equal(evidence.cause?.code, "TEST_CLOSED"); assert.match(evidence.stack!, /fetch failed/);
  const cycle = new Error("cyclic cause"); cycle.cause = cycle;
  assert.doesNotThrow(() => JSON.stringify(errorEvidence(cycle)));
  assert.deepEqual(errorEvidence("foreign failure"), {name: "NonError", message: "foreign failure"});
});
