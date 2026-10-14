import assert from "node:assert/strict";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { QueryResult } from "@leostera/poneglyph";
import { createPoneglyphMcpHandler, type ScopedGraphReader } from "../src/index.js";

const result: QueryResult = { rows: [{ Value: { type: "integer", value: "9007199254740993" } }], snapshotSeq: 1, metrics: { scanCalls: 1, shardRequests: 1, tuplesRead: 1, bytesRead: 40, directoryRequests: 1 } };
async function withGraph(getGraph: () => Promise<ScopedGraphReader>, run: (client: Client) => Promise<void>) {
  const handler = createPoneglyphMcpHandler({ getGraph, dataset: { name: "RPC fixture" }, allowedHostnames: ["example.test"] });
  const client = new Client({ name: "scope-test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("https://example.test/mcp"), { fetch: (input, init) => {
      const request = new Request(input, init); request.headers.set("host", "example.test"); return handler.fetch(request);
    } }));
    await run(client);
  } finally { await client.close(); }
}

test("scoped graph is lazy, retained through the read, and disposed exactly once", { timeout: 10_000 }, async () => {
  let acquired = 0, disposed = 0;
  const started = Promise.withResolvers<void>(), finished = Promise.withResolvers<QueryResult>();
  await withGraph(async () => { acquired++; return { query: async () => { started.resolve(); return finished.promise; }, [Symbol.dispose]() { disposed++; } }; }, async client => {
    await client.listTools(); await client.callTool({ name: "describe_dataset", arguments: {} });
    assert.equal(acquired, 0);
    const invalid = await client.callTool({ name: "query", arguments: { query: "not Datalog" } });
    assert.equal(invalid.isError, true); assert.equal(acquired, 0);
    const pending = client.callTool({ name: "query", arguments: { query: "test:bytes(Entity, Value)" } });
    await started.promise;
    assert.equal(acquired, 1); assert.equal(disposed, 0);
    finished.resolve(result);
    const answer = await pending;
    assert.notEqual(answer.isError, true); assert.equal(disposed, 1);
    assert.ok("content" in answer && answer.content[0]?.type === "text");
    assert.deepEqual(JSON.parse(answer.content[0].text), result);
  });
  assert.equal(disposed, 1);
});

test("RPC error fields survive without custom prototypes and always release the handle", { timeout: 10_000 }, async () => {
  for (const [name, fields, code] of [
    ["PoneglyphInputError", {}, "invalid_query"],
    ["PoneglyphRequestError", { status: 413, retryable: false }, "query_rejected"],
    ["PoneglyphRequestError", { status: "413", retryable: false }, "backend_unavailable"],
    ["PoneglyphProtocolError", {}, "invalid_backend_response"],
    ["GraphAuthorizationError", {}, "query_rejected"],
  ] as const) {
    let calls = 0, disposed = 0;
    const failure = Object.assign(new Error("fixture error"), { name, ...fields });
    await withGraph(async () => ({ query: async () => { calls++; throw failure; }, [Symbol.dispose]() { disposed++; } }), async client => {
      const answer = await client.callTool({ name: "query", arguments: { query: "test:bytes(Entity, Value)" } });
      assert.equal(answer.isError, true);
      assert.ok("content" in answer && answer.content[0]?.type === "text");
      assert.equal(JSON.parse(answer.content[0].text).error.code, code);
    });
    assert.equal(calls, 1); assert.equal(disposed, 1);
  }
});
