import assert from "node:assert/strict";
import {test} from "vitest";
import {parseActorFingerprint} from "./actor-fingerprint.js";
const valid = {objectId: "a".repeat(64), incarnation: "12345678-1234-4234-8234-123456789abc"};
test("actor identity/incarnation are parsed, not inferred from an abort error", () => {
  assert.deepEqual(parseActorFingerprint(valid), valid);
  assert.ok(Object.isFrozen(parseActorFingerprint(valid)));
  for (const input of [null, [], {}, {...valid, objectId: "short"}, {...valid, objectId: 1}, {...valid, incarnation: "not a UUID"}, {...valid, incarnation: "12345678-1234-1234-8234-123456789abc"}]) assert.throws(() => parseActorFingerprint(input));
});
