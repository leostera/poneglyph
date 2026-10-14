import assert from "node:assert/strict";
import { test } from "node:test";
import { isRecord, main } from "../src/main.ts";

test("smoke rejects non-object response envelopes", () => {
  for (const value of [null, [], 1, "committed", true]) assert.equal(isRecord(value), false);
  assert.equal(isRecord({ status: "committed" }), true);
});

test("smoke write/replay/query flow runs against fake responses only", async (t) => {
  const writes: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const body: Record<string, unknown> = JSON.parse(String(init?.body));
    if (String(input).endsWith("/transactions")) {
      writes.push(body);
      return Response.json({ status: "committed", commitSeq: 1, txId: body["txId"] });
    }
    return Response.json({ snapshotSeq: 1, rows: Array.from({ length: 4 }, (_, index) => ({ Entity: { type: "string", value: `test:entity:${index}` } })), metrics: { shardRequests: 1 } });
  });
  const log = t.mock.method(console, "log", () => {});
  await main();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], writes[1], "replay must retain the original identity and entire payload");
  assert.equal(log.mock.callCount(), 1);
});

test("built cloud smoke imports without contacting the configured endpoint", async (t) => {
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("network forbidden"); });
  const entry = await import(new URL("../dist/main.js", import.meta.url).href);
  assert.equal(typeof entry.main, "function");
  assert.equal(network.mock.callCount(), 0);
});
