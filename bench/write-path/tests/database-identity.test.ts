import assert from "node:assert/strict";
import {test} from "node:test";
import {identifyDatabaseImplementation} from "../database-identity.js";
test("benchmark identity comes from both canonical bundled actors", () => {
  assert.equal(identifyDatabaseImplementation(["../../poneglyph/src/storage/coordinator.ts", "C:\\repo\\poneglyph\\src\\storage\\shard.ts"]), "poneglyph-pooled-owner-write-path");
  for (const inputs of [[], ["/src/storage/coordinator.ts"], ["/src/storage/coordinator.ts", "/src/storage-g/shard.ts"], ["/src/storage/coordinator.ts", "/src/storage/shard.ts", "/src/storage-c/coordinator.ts"]]) assert.throws(() => identifyDatabaseImplementation(inputs));
});
