import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createDatabase, type FetchFunction } from "@leostera/poneglyph";
import { createPoneglyphMcpHandler, type GraphReader } from "../src/index.js";
const MCP_URL = "https://example.test/mcp";
const DATASET = { name: "Example graph", graphId: "example", schemaNote: "Use get_schema for observed fields." };
const schema = {snapshotSeq: 7, sequenceScope: "subtree-vector", snapshotVector: [{prefix: "0000", sequence: 7, epoch: 1}],
  fields: [{field: "wiki:page:title", valueTags: ["text"]}]};

const metrics = { scanCalls: 1, shardRequests: 1, tuplesRead: 2, bytesRead: 128, directoryRequests: 1 };
const answer = { rows: [{ Value: { type: "integer", value: "9223372036854775807" } }, { Value: { type: "integer", value: "9223372036854775807" } }], snapshotSeq: 7, metrics };

async function withClient(reader: GraphReader, run: (client: Client) => Promise<void>) {
  const handler = createPoneglyphMcpHandler({ reader, dataset: DATASET, allowedHostnames: ["example.test"] });
  const client = new Client({ name: "offline-playground-test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: (input, init) => {
        const request = new Request(input, init);
        request.headers.set("host", "example.test"); // normally supplied by HTTP transport
        return handler.fetch(request);
      },
    }));
    await run(client);
  } finally { await client.close(); }
}

function toolPayload(result: Awaited<ReturnType<Client["callTool"]>>) {
  assert.ok("content" in result);
  assert.equal(result.content.length, 1);
  const first = result.content[0];
  assert.ok(first?.type === "text");
  return JSON.parse(first.text);
}

function fakeGraph(fetcher: FetchFunction): GraphReader {
  return createDatabase({ url: "https://database.internal", graphId: "example", fetch: fetcher });
}

test("only anonymous read tools are advertised; dataset guidance is explicit", async () => {
  await withClient(fakeGraph(async () => { throw new Error("schema must not contact storage"); }), async client => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ["describe_dataset", "get_schema", "query"]);
    for (const tool of tools) assert.equal(tool.annotations?.readOnlyHint, true);
    const result = await client.callTool({ name: "describe_dataset", arguments: {} });
    assert.deepEqual(toolPayload(result), DATASET);
  });
});

test("get_schema returns observed fields and its declared snapshot without schema inference", async () => {
  await withClient(fakeGraph(async (input, init) => {
    assert.equal(String(input), "https://database.internal/v1/graphs/example/schema");
    assert.deepEqual(JSON.parse(String(init?.body)), {});
    return Response.json(schema);
  }), async client => {
    const result = await client.callTool({name: "get_schema", arguments: {}});
    assert.notEqual(result.isError, true);
    assert.deepEqual(toolPayload(result), schema);
  });
});

test("malformed observed schemas fail as backend protocol errors", async () => {
  await withClient(fakeGraph(async () => Response.json({...schema, snapshotSeq: 6})), async client => {
    const result = await client.callTool({name: "get_schema", arguments: {}});
    assert.equal(result.isError, true);
    assert.equal(toolPayload(result).error.code, "invalid_backend_response");
  });
});

test("complete typed rows, duplicates, int64, snapshot and metrics survive MCP", async () => {
  let calls = 0;
  await withClient(fakeGraph(async (input, init) => {
    calls++;
    assert.equal(String(input), "https://database.internal/v1/graphs/example/query");
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), { query: "wiki:page:text_bytes(Page, Value)" });
    return Response.json(answer);
  }), async client => {
    const result = await client.callTool({ name: "query", arguments: { query: "wiki:page:text_bytes(Page, Value)" } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(toolPayload(result), answer);
  });
  assert.equal(calls, 1);
});

test("malformed Datalog fails before storage; tool arguments cannot select a graph or backend", async () => {
  let calls = 0;
  await withClient(fakeGraph(async () => { calls++; return Response.json(answer); }), async client => {
    const result = await client.callTool({ name: "query", arguments: { query: "SELECT * FROM facts" } });
    assert.equal(result.isError, true);
    assert.equal(toolPayload(result).error.code, "invalid_query");
    for (const extra of [{ graphId: "another-graph" }, { url: "https://attacker.example" }, { limit: 1 }]) {
      const rejected = await client.callTool({ name: "query", arguments: { query: "wiki:page:title(Page, Title)", ...extra } });
      assert.equal(rejected.isError, true);
    }
  });
  assert.equal(calls, 0);
});

test("schema and query budget/busy errors remain errors, not partial or empty successes", async () => {
  for (const status of [413, 429]) {
    await withClient(fakeGraph(async () => Response.json({ error: "query budget or admission rejected", retryable: status === 429 }, { status })), async client => {
      for (const name of ["query", "get_schema"]) {
        const result = await client.callTool({name, arguments: name === "query" ? {query: "wiki:page:title(Page, Title)"} : {}});
        assert.equal(result.isError, true);
        const payload = toolPayload(result);
        assert.equal(payload.error.code, name === "query" ? "query_rejected" : "schema_rejected");
        assert.equal(payload.error.status, status);
        assert.equal(payload.error.retryable, status === 429);
        assert.equal("rows" in payload, false);
      }
    });
  }
});

test("each read-tool failure is logged once, without retry or leaking backend details", async () => {
  const logs = vi.spyOn(console, "error").mockImplementation(() => {});
  let calls = 0;
  await withClient(fakeGraph(async () => { calls++; throw new Error("private backend credential must never appear"); }), async client => {
    for (const name of ["query", "get_schema"]) {
      const result = await client.callTool({name, arguments: name === "query" ? {query: "wiki:page:title(Page, Title)"} : {}});
      assert.equal(result.isError, true);
      assert.equal(toolPayload(result).error.code, "backend_unavailable");
      assert.doesNotMatch(JSON.stringify(result), /private backend credential/);
    }
  });
  assert.equal(calls, 2);
  assert.deepEqual(logs.mock.calls.map(call => {
    const line: unknown = call[0];
    assert.ok(typeof line === "string");
    return JSON.parse(line);
  }), ["query", "schema"].map(tool => ({event: `poneglyph-mcp-${tool}-failed`, code: "backend_unavailable", kind: "transport"})));
});

test("malformed successful backend replies never become valid MCP answers", async () => {
  for (const invalid of [{ ...answer, metrics: {} }, { ...answer, rows: [{ Value: { type: "integer", value: "not-an-integer" } }] }]) {
    await withClient(fakeGraph(async () => Response.json(invalid)), async client => {
      const result = await client.callTool({ name: "query", arguments: { query: "wiki:page:title(Page, Title)" } });
      assert.equal(result.isError, true);
      assert.equal(toolPayload(result).error.code, "invalid_backend_response");
    });
  }
});

test("playground response budget fails without slicing rows", async () => {
  await withClient(fakeGraph(async () => Response.json({ ...answer, rows: [{ Value: { type: "string", value: "x".repeat(2_000_001) } }] })), async client => {
    const result = await client.callTool({ name: "query", arguments: { query: "wiki:page:title(Page, Title)" } });
    assert.equal(result.isError, true);
    assert.equal(toolPayload(result).error.code, "response_budget_exceeded");
  });
});
