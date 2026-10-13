import {test} from "node:test";
import assert from "node:assert/strict";
import {identifyActorInputs, implementations} from "./build.js";
const g = implementations.find(implementation => implementation.name === "G")!;
const path = (directory: string, role: string) => `poneglyph/src/${directory}/${role}.ts`;
test("runtime identity follows both actual actor classes", () => {
  assert.equal(identifyActorInputs([path("storage-g", "coordinator"), path("storage-g", "shard"), "poneglyph/src/datalog/value.ts"], g), "storage-g");
});
test("mixed shard, missing actor and unknown actor implementations fail closed", () => {
  for (const inputs of [[path("storage-g", "coordinator"), path("storage", "shard")], [path("storage-g", "coordinator")], [path("storage-g", "coordinator"), path("storage-g", "shard"), path("storage-unknown", "shard")]]) {
    assert.throws(() => identifyActorInputs(inputs, g));
  }
});
