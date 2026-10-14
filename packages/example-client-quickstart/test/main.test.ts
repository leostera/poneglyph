import assert from "node:assert/strict";
import { test } from "node:test";
import { quickstart } from "../src/main.ts";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

test("quickstart uses packaged client exports, stable identity and the three-relation join", async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const rows = [{ Service: { type: "string", value: "app:service:auth-api" }, Task: { type: "string", value: "app:task:rotate-key" }, Owner: { type: "string", value: "app:person:ari" } }];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input), body: Record<string, unknown> = JSON.parse(String(init?.body));
    requests.push({ url, body });
    return url.endsWith("/transactions")
      ? json({ txId: body["txId"], status: "committed", commitSeq: 7 })
      : json({ snapshotSeq: 7, rows, metrics: { scanCalls: 3, shardRequests: 3, tuplesRead: 3, bytesRead: 300, directoryRequests: 3 } });
  };
  const result = await quickstart("https://example.invalid", fetcher);
  // The client intentionally returns prototype-free bindings. Compare exact
  // typed content without making the example depend on a record prototype.
  assert.deepEqual({ ...result, rows: result.rows.map(row => ({ ...row })) }, { txId: "release:quickstart-v1", snapshotSeq: 7, rows });
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, "https://example.invalid/v1/graphs/release-assistant/transactions");
  assert.equal(requests[0]?.body["txId"], "release:quickstart-v1");
  assert.equal((requests[0]?.body["facts"] as unknown[]).length, 3);
  assert.equal(requests[1]?.body["query"], 'app:service:blocked-by(Service, Task), app:task:status(Task, "open"), app:task:owner(Task, Owner)');
});

test("quickstart rejects malformed successful receipts before querying", async () => {
  let requests = 0;
  await assert.rejects(quickstart("https://example.invalid", async () => { requests++; return json({ status: "committed" }); }));
  assert.equal(requests, 1);
});

test("built quickstart imports without writing to an endpoint", async (t) => {
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("network forbidden"); });
  const entry = await import(new URL("../dist/main.js", import.meta.url).href);
  assert.equal(typeof entry.main, "function");
  assert.equal(network.mock.callCount(), 0);
});
