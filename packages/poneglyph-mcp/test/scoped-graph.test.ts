import assert from "node:assert/strict";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { GraphSchemaObservation, QueryResult } from "@leostera/poneglyph";
import { createPoneglyphMcpHandler, type ScopedGraphReader } from "../src/index.js";

const result: QueryResult = { rows: [{ Value: { type: "integer", value: "9007199254740993" } }], snapshotSeq: 1, metrics: { scanCalls: 1, shardRequests: 1, tuplesRead: 1, bytesRead: 40, directoryRequests: 1 } };
const schema: GraphSchemaObservation = {snapshotSeq: 1, sequenceScope: "subtree-vector", snapshotVector: [{prefix: "0000", sequence: 1, epoch: 0}],
  fields: [{field: "test:bytes", valueTags: ["number"]}]};
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
  await withGraph(async () => { acquired++; return { query: async () => { started.resolve(); return finished.promise; }, getSchema: async () => schema, [Symbol.dispose]() { disposed++; } }; }, async client => {
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

test("get_schema uses a lazy read capability and disposes it after the observation", async () => {
  let acquired = 0, disposed = 0;
  await withGraph(async () => { acquired++; return {query: async () => result, getSchema: async () => schema, [Symbol.dispose]() { disposed++; }}; }, async client => {
    await client.listTools();
    assert.equal(acquired, 0);
    const answer = await client.callTool({name: "get_schema", arguments: {}});
    assert.notEqual(answer.isError, true);
    assert.deepEqual(toolPayload(answer), schema);
    assert.equal(acquired, 1);
    assert.equal(disposed, 1);
  });
});

function toolPayload(result: Awaited<ReturnType<Client["callTool"]>>) {
  assert.ok("content" in result);
  const text = result.content[0];
  assert.ok(text?.type === "text");
  return JSON.parse(text.text);
}

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
    await withGraph(async () => ({ query: async () => { calls++; throw failure; }, getSchema: async () => schema, [Symbol.dispose]() { disposed++; } }), async client => {
      const answer = await client.callTool({ name: "query", arguments: { query: "test:bytes(Entity, Value)" } });
      assert.equal(answer.isError, true);
      assert.ok("content" in answer && answer.content[0]?.type === "text");
      assert.equal(JSON.parse(answer.content[0].text).error.code, code);
    });
    assert.equal(calls, 1); assert.equal(disposed, 1);
  }
});
