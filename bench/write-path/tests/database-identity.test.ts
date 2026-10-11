import assert from "node:assert/strict";
import { test } from "node:test";
import { identifyDatabaseImplementation } from "../database-identity.js";

test("report identity follows the sole bundled coordinator implementation", () => {
  assert.equal(identifyDatabaseImplementation(["../../poneglyph/src/storage/coordinator.ts"]), "A-central-coordinator-correctness");
  assert.equal(identifyDatabaseImplementation(["../../poneglyph/src/storage-candidate/coordinator.ts"]), "B1-independent-subtrees");
  assert.equal(identifyDatabaseImplementation(["C:\\repo\\poneglyph\\src\\storage-c\\coordinator.ts"]), "C-pooled-coordinator-ledgers");
  assert.throws(() => identifyDatabaseImplementation([]), /exactly one/);
  assert.throws(() => identifyDatabaseImplementation(["/src/storage/coordinator.ts", "/src/storage-c/coordinator.ts"]), /exactly one/);
});
