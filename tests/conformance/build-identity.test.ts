import assert from "node:assert/strict";
import {test} from "node:test";
import {identifyActorInputs} from "./build.js";
const path = (directory: string, role: string) => `../../poneglyph/src/${directory}/${role}.ts`;
test("conformance builds the sole production coordinator and shard", () => {
  assert.equal(identifyActorInputs([path("storage", "coordinator"), path("storage", "shard"), "poneglyph/src/datalog/value.ts"]), "poneglyph-pooled-owner-write-path");
});
test("obsolete, mixed, missing and unknown actors fail closed", () => {
  for (const inputs of [[path("storage", "coordinator"), path("storage-g", "shard")], [path("storage", "coordinator")], [path("storage", "coordinator"), path("storage", "shard"), path("storage-unknown", "shard")]]) assert.throws(() => identifyActorInputs(inputs));
});
