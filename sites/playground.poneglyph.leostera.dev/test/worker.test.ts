import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createDatabase } from "@leostera/poneglyph";
import { DATASET, GRAPH_ID, MCP_URL } from "../src/dataset.js";
import { RATE_LIMIT } from "../src/rate-limit.js";
import { COMPATIBILITY_DATE } from "../src/runtime.js";

const site = resolve(import.meta.dirname, "..");
const luffy = "wiki:onepiece:page:Monkey%20D.%20Luffy";
const zoro = "wiki:onepiece:page:Roronoa%20Zoro";

// Miniflare's Node/Undici response and generated Workers Response are distinct
// platform types. Copy these tiny test replies instead of asserting equivalence.
async function testResponse(response: { text(): Promise<string>; status: number; headers: Iterable<[string, string]> }): Promise<Response> {
  return new Response(await response.text(), { status: response.status, headers: Object.fromEntries(response.headers) });
}

// Finite native integration, not a corpus load/performance/certification run.
test("public Agents MCP reaches the real canonical SQLite runtime, with read-only and rate-limit boundaries", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "poneglyph-playground-test-"));
  let complete = false;
  let runtime: Miniflare | undefined;
  const client = new Client({ name: "native-playground-test", version: "1" });
  try {
    await build({ absWorkingDir: site, entryPoints: { playground: "src/index.ts", database: "src/database.ts" },
      outdir: directory, outExtension: { ".js": ".mjs" }, bundle: true, format: "esm", platform: "browser",
      target: "es2024", conditions: ["workerd", "worker", "browser"], external: ["cloudflare:*", "node:*"], });
    const manifest = (contents: string) => ({ mainModule: "index.mjs", modules: { "index.mjs": { type: "esm" as const, contents } } });
    const playground = manifest(await readFile(resolve(directory, "playground.mjs"), "utf8"));
    runtime = new Miniflare({ port: 0, host: "127.0.0.1", resourcePersistencePath: resolve(directory, "state"),
      telemetry: { enabled: false }, log: new Log(LogLevel.WARN), workers: [
        { config: { name: "playground", manifest: playground, compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: ["nodejs_compat"],
          env: { PONEGLYPH: { type: "worker", worker: "database" }, MCP_RATE_LIMITER: { type: "rate-limit", ...RATE_LIMIT } } } },
        { config: { name: "database", manifest: manifest(await readFile(resolve(directory, "database.mjs"), "utf8")), compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: ["nodejs_compat"],
          env: { GRAPH_COORDINATORS: { type: "durable-object", worker: "database", exportName: "GraphCoordinatorDO" }, GRAPH_SHARDS: { type: "durable-object", worker: "database", exportName: "GraphShardDO" } },
          exports: { GraphCoordinatorDO: { type: "durable-object", storage: "sqlite" }, GraphShardDO: { type: "durable-object", storage: "sqlite" } } } },
        // Same public entrypoint, deliberately missing DB binding, with one token.
        { config: { name: "rate-limited", manifest: playground, compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: ["nodejs_compat"],
          env: { MCP_RATE_LIMITER: { type: "rate-limit", namespace: "2026101402", simple: { limit: 1, period: 60 } } } } },
      ] });
    await runtime.ready;
    const active = runtime;
    const database = await active.getWorker("database");
    const graph = createDatabase({ url: "https://database.internal", graphId: GRAPH_ID, fetch: async (input, init) => {
      const request = new Request(input, init);
      return testResponse(await database.fetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() }));
    } });
    const receipt = await graph.transact([
      { source: "fixture:playground", entity: luffy, field: "wiki:page:title", value: { type: "text", value: "Monkey D. Luffy" } },
      { source: "fixture:playground", entity: luffy, field: "wiki:page:category", value: { type: "text", value: "Pirates" } },
      { source: "fixture:playground", entity: luffy, field: "wiki:page:link", value: { type: "text", value: "Roronoa Zoro" } },
      { source: "fixture:playground", entity: luffy, field: "wiki:page:namespace", value: { type: "number", value: "0" } },
      { source: "fixture:playground", entity: luffy, field: "wiki:page:text_bytes", value: { type: "number", value: "140" } },
      { source: "fixture:playground", entity: zoro, field: "wiki:page:title", value: { type: "text", value: "Roronoa Zoro" } },
    ], { txId: "fixture:playground:one" });
    assert.equal(receipt.status, "committed");

    const home = await active.dispatchFetch("https://playground.poneglyph.leostera.dev/");
    assert.equal(home.status, 200);
    assert.match(await home.text(), /https:\/\/playground\.poneglyph\.leostera\.dev\/mcp/);
    for (const path of ["/v1/graphs/onepiece/transactions", "/v1/graphs/onepiece/query", "/_transact", "/__e2e/inspect", "/todo"]) {
      assert.equal((await active.dispatchFetch(`https://playground.poneglyph.leostera.dev${path}`, { method: "POST", body: "{}" })).status, 404);
    }
    const preflight = await active.dispatchFetch(MCP_URL, { method: "OPTIONS", headers: { origin: "https://any-agent.example" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    assert.equal((await active.dispatchFetch(MCP_URL)).status, 405);
    assert.equal((await active.dispatchFetch("https://attacker.example/mcp", { method: "POST", body: "{}" })).status, 403);

    await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: async (input, init) => {
      const request = new Request(input, init);
      // No Authorization, cookie or API key. A browser agent Origin is allowed.
      request.headers.set("origin", "https://any-agent.example");
      return testResponse(await active.dispatchFetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body: request.method === "POST" ? await request.text() : undefined }));
    } }));
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ["describe_dataset", "query"]);
    // Two concurrent requests must not share a connected MCP server/transport.
    const [result, integer] = await Promise.all([
      client.callTool({ name: "query", arguments: { query: DATASET.examples[2] } }),
      client.callTool({ name: "query", arguments: { query: DATASET.examples[3] } }),
    ]);
    assert.notEqual(result.isError, true);
    assert.ok("content" in result && result.content[0]?.type === "text");
    const answer = JSON.parse(result.content[0].text);
    assert.deepEqual(answer.rows, [{ Page: { type: "string", value: luffy }, TargetTitle: { type: "string", value: "Roronoa Zoro" }, TargetPage: { type: "string", value: zoro } }]);
    assert.ok(answer.metrics.shardRequests > 0);
    assert.ok("content" in integer && integer.content[0]?.type === "text");
    assert.deepEqual(JSON.parse(integer.content[0].text).rows, [{ Page: { type: "string", value: luffy }, Namespace: { type: "integer", value: "0" }, Bytes: { type: "integer", value: "140" } }]);

    // Ordinary 2025 Streamable HTTP clients use the SDK's legacy stateless lane.
    const legacy = await active.dispatchFetch(MCP_URL, { method: "POST", headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 17, method: "tools/call", params: { name: "query", arguments: { query: DATASET.examples[0] } } }) });
    assert.equal(legacy.status, 200);
    const legacyText = await legacy.text();
    const legacyFrames = legacy.headers.get("content-type")?.includes("text/event-stream")
      ? legacyText.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)))
      : [JSON.parse(legacyText)];
    assert.equal(legacyFrames.length, 1);
    assert.equal(legacyFrames[0].id, 17);
    assert.deepEqual(JSON.parse(legacyFrames[0].result.content[0].text).rows, [{ Page: { type: "string", value: luffy } }]);

    const batched = await active.dispatchFetch(MCP_URL, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query", arguments: { query: DATASET.examples[0] } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "query", arguments: { query: DATASET.examples[0] } } },
    ]) });
    assert.equal(batched.status, 400);
    assert.match(await batched.text(), /batching is not supported/);

    const oversize = await active.dispatchFetch(MCP_URL, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: " ".repeat(65_537) });
    assert.equal(oversize.status, 413);
    assert.equal(oversize.headers.get("access-control-allow-origin"), "*");

    const limited = await active.getWorker("rate-limited");
    const first = await limited.fetch(MCP_URL, { method: "POST", body: "{}" });
    assert.equal(first.status, 503); // token granted, but no DB; no unlimited bypass
    const denied = await limited.fetch(MCP_URL, { method: "POST", body: "{}" });
    assert.equal(denied.status, 429);
    assert.equal(denied.headers.get("retry-after"), "60");
    assert.equal(denied.headers.get("access-control-allow-origin"), "*");
    await denied.text();
    await first.text();
    complete = true;
  } finally {
    await client.close();
    if (runtime !== undefined) await runtime.dispose();
    if (complete) await rm(directory, { recursive: true, force: true });
    else console.error(JSON.stringify({ event: "incomplete-playground-test", directory }));
  }
});
