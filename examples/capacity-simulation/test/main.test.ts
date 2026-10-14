import assert from "node:assert/strict";
import { test } from "node:test";
import { simulate } from "../src/main.ts";

test("simulation accounts logical bytes without writing payloads", async () => {
  const result = await simulate(1_000_000, 16);
  assert.equal(result.logicalBytes, 1_000_000);
  assert.equal(result.syntheticEntities, 16);
  assert.equal(result.physicalRowsWritten, 0);
  assert.equal(result.physicalPayloadBytesWritten, 0);
  assert.equal(result.leaves, 1);
  assert.ok(result.maxAccountedBytes < result.applicationAccountedLimitBytes);
});

test("invalid simulation inputs fail rather than manufacture accounting evidence", async () => {
  await assert.rejects(simulate(0, 16), /logicalBytes must be positive/);
  await assert.rejects(simulate(100, -1), /syntheticEntities must be positive/);
});

test("built entrypoint imports without running a simulation or network request", async (t) => {
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("network forbidden"); });
  const entry = await import(new URL("../dist/main.js", import.meta.url).href);
  assert.equal(typeof entry.main, "function");
  assert.equal(network.mock.callCount(), 0);
});
