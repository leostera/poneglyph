import assert from "node:assert/strict";
import { test } from "node:test";
import { identifyDatabaseImplementation } from "../database-identity.js";

test("report identity follows the sole bundled coordinator implementation", () => {
  assert.equal(identifyDatabaseImplementation(["../../poneglyph/src/storage/coordinator.ts"]), "A-central-coordinator-correctness");
  assert.equal(identifyDatabaseImplementation(["../../poneglyph/src/storage-candidate/coordinator.ts"]), "B1-independent-subtrees");
  assert.equal(identifyDatabaseImplementation(["C:\\repo\\poneglyph\\src\\storage-c\\coordinator.ts"]), "C-pooled-coordinator-ledgers");
  assert.equal(identifyDatabaseImplementation(["../../poneglyph/src/storage-g/coordinator.ts"]), "G-integrated-write-path");
  assert.equal(identifyDatabaseImplementation(["../../poneglyph/src/storage-h/coordinator.ts"]), "H-epoch-fenced-route-cache");
  assert.throws(() => identifyDatabaseImplementation(["/src/storage-h/coordinator.ts", "/src/storage-g/coordinator.ts"]), /exactly one/);
  assert.throws(() => identifyDatabaseImplementation(["/src/storage-g/coordinator.ts", "/src/storage-d/coordinator.ts"]), /exactly one/);
  assert.throws(() => identifyDatabaseImplementation([]), /exactly one/);
  assert.throws(() => identifyDatabaseImplementation(["/src/storage/coordinator.ts", "/src/storage-c/coordinator.ts"]), /exactly one/);
});
