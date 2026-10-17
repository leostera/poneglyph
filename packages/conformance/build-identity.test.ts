import assert from "node:assert/strict";
import {test} from "node:test";
import {identifyActorInputs} from "./build.js";

const path = (directory: string, role: string) => `../poneglyph/src/${directory}/${role}.ts`;
const canonical = [
  path("storage", "coordinator-facade"),
  path("storage", "ledger-do"),
  path("storage", "coordinator"),
  path("storage", "shard"),
];

test("conformance builds the exact four production storage roles", () => {
  assert.equal(identifyActorInputs([...canonical, "../poneglyph/src/datalog/value.ts"]), "poneglyph-pooled-owner-write-path");
});

test("obsolete, mixed, missing and unknown actors fail closed", () => {
  for (const inputs of [
    canonical.slice(1),
    [...canonical.slice(0, 3)],
    [...canonical, path("storage-g", "shard")],
    [...canonical, path("storage-unknown", "ledger-do")],
  ]) assert.throws(() => identifyActorInputs(inputs));
});
