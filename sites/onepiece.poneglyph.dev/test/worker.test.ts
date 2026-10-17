import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { DATASET, MCP_URL, PUBLIC_HOST } from "../src/dataset.js";
import { RATE_LIMIT } from "../src/rate-limit.js";
import { COMPATIBILITY_DATE, GRAPH_ID } from "../src/runtime.js";
import { IMPORT_ACCESS_AUDIENCE, IMPORT_RATE_LIMIT } from "../src/import-contract.js";
import { body as importBody, entity as importedEntity, txId as importTxId, fixturePlan } from "./import-fixture.js";

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
    await build({ absWorkingDir: site, entryPoints: { playground: "src/index.ts", database: "../../packages/poneglyph-worker/src/index.ts", operator: "src/operator.ts" },
      outdir: directory, outExtension: { ".js": ".mjs" }, bundle: true, format: "esm", platform: "browser",
      target: "es2024", conditions: ["workerd", "worker", "browser"], external: ["cloudflare:*", "node:*"],
      plugins: [{ name: "tiny-offline-import-plan", setup(builder) {
        builder.onLoad({ filter: /\/src\/import-plan-remainder90\.json$/ }, () => ({ contents: JSON.stringify(fixturePlan()), loader: "json" }));
      } }], });
    const manifest = (contents: string) => ({ mainModule: "index.mjs", modules: { "index.mjs": { type: "esm" as const, contents } } });
    const playground = manifest(await readFile(resolve(directory, "playground.mjs"), "utf8"));
    runtime = new Miniflare({ port: 0, host: "127.0.0.1", resourcePersistencePath: resolve(directory, "state"),
      telemetry: { enabled: false }, log: new Log(LogLevel.WARN), workers: [
        { dev: { access: { aud: IMPORT_ACCESS_AUDIENCE, identity: { email: "member@example.test" } } },
          config: { name: "playground", manifest: playground, compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: ["nodejs_compat"],
          env: { PONEGLYPH: { type: "worker", worker: "database", props: { clientId: "playground" } }, MCP_RATE_LIMITER: { type: "rate-limit", ...RATE_LIMIT },
            PONEGLYPH_IMPORT: { type: "worker", worker: "database", props: { clientId: "playground-importer" } }, IMPORT_RATE_LIMITER: { type: "rate-limit", ...IMPORT_RATE_LIMIT } } } },
        { config: {
          name: "database",
          manifest: manifest(await readFile(resolve(directory, "database.mjs"), "utf8")),
          compatibilityDate: COMPATIBILITY_DATE,
          compatibilityFlags: ["nodejs_compat"],
          env: {
            GRAPH_FACADES: { type: "durable-object", worker: "database", exportName: "GraphCoordinatorDO" },
            GRAPH_LEDGERS: { type: "durable-object", worker: "database", exportName: "GraphLedgerDO" },
            GRAPH_TREES: { type: "durable-object", worker: "database", exportName: "GraphTreeDO" },
            GRAPH_SHARDS: { type: "durable-object", worker: "database", exportName: "GraphShardDO" },
            GRAPH_GRANTS: { type: "json", value: { playground: { onepiece: ["read"] }, "playground-loader": { onepiece: ["read", "write"] }, "playground-importer": { onepiece: ["read", "write"] } } },
          },
          exports: {
            GraphCoordinatorDO: { type: "durable-object", storage: "sqlite" },
            GraphLedgerDO: { type: "durable-object", storage: "sqlite" },
            GraphTreeDO: { type: "durable-object", storage: "sqlite" },
            GraphShardDO: { type: "durable-object", storage: "sqlite" },
          },
        } },
        { config: { name: "operator", manifest: manifest(await readFile(resolve(directory, "operator.mjs"), "utf8")), compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: ["nodejs_compat"],
          env: { PONEGLYPH: { type: "worker", worker: "database", props: { clientId: "playground-loader" } } } } },
        // Same public entrypoint, deliberately missing DB binding, with one token.
        { config: { name: "rate-limited", manifest: playground, compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: ["nodejs_compat"],
          env: { MCP_RATE_LIMITER: { type: "rate-limit", namespace: "2026101402", simple: { limit: 1, period: 60 } } } } },
      ] });
    await runtime.ready;
    const active = runtime;
    const operator = await active.getWorker("operator");
    for (const [url, init, status] of [
      ["https://playground.poneglyph.leostera.dev/seed", { method: "POST" }, 403],
      ["http://127.0.0.1/seed", { method: "POST", headers: { origin: "https://attacker.example", "content-type": "application/json" } }, 403],
      ["http://127.0.0.1/seed", { method: "GET" }, 404],
      ["http://127.0.0.1/v1/graphs/another/transactions", { method: "POST" }, 404],
    ] as const) {
      const denied = await operator.fetch(url, init); assert.equal(denied.status, status); await denied.text();
    }
    const seed = await operator.fetch("http://127.0.0.1/seed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ graphId: "attacker", txId: "different", facts: [] }) });
    assert.equal(seed.status, 200);
    const seeded = await seed.json() as Record<string, unknown>;
    assert.match(String(seeded.txId), /^poneglyph:tx:/);
    assert.deepEqual({...seeded, txId: "server-minted"}, {txId: "server-minted", graphId: GRAPH_ID, facts: 6, dataset: "synthetic-smoke-fixture; not wiki corpus"});

    // Direct native invocation bypasses the cloud Access edge; these assertions
    // verify exact hostname routing, not hosted authentication.
    assert.equal(PUBLIC_HOST, "onepiece.poneglyph.dev");
    assert.equal(MCP_URL, "https://onepiece.poneglyph.dev/mcp");
    const home = await active.dispatchFetch(`https://${PUBLIC_HOST}/`);
    assert.equal(home.status, 200);
    const page = await home.text();
    assert.ok(page.includes(MCP_URL));
    assert.match(page, /Private via Cloudflare Access/);
    assert.doesNotMatch(page, /Public and anonymous/);
    assert.match(DATASET.access.authentication, /Cloudflare Access/);
    assert.match(DATASET.currentDataNote, /routing-version-9 graph was freshly deployed and currently has no imported facts/);
    assert.match(DATASET.currentDataNote, /previous v8 load-test dataset and its receipts\/query evidence are historical only/);
    assert.match(DATASET.currentDataNote, /Imports remain paused/);
    for (const path of ["/v1/graphs/onepiece/transactions", "/v1/graphs/onepiece/query", "/_transact", "/__e2e/inspect", "/todo"]) {
      assert.equal((await active.dispatchFetch(`https://${PUBLIC_HOST}${path}`, { method: "POST", body: "{}" })).status, 404);
    }
    const preflight = await active.dispatchFetch(MCP_URL, { method: "OPTIONS", headers: { origin: "https://any-agent.example" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    assert.equal((await active.dispatchFetch(MCP_URL)).status, 405);
    for (const hostname of ["attacker.example", "onepiece.poneglyph.dev.attacker.example", "playground.poneglyph.leostera.dev"]) {
      assert.equal((await active.dispatchFetch(`https://${hostname}/mcp`, { method: "POST", body: "{}" })).status, 403);
    }

    const importOptions = { method: "POST", headers: { "content-type": "application/json" }, body: importBody };
    // Direct service invocation cannot propagate Access, even for this Worker.
    const directSite = await active.getWorker("playground");
    const noIdentity = await directSite.fetch(`https://${PUBLIC_HOST}/import`, importOptions);
    assert.equal(noIdentity.status, 401); await noIdentity.text();
    // HTTP ingress receives the explicitly simulated trusted Access context.
    const imported = await active.dispatchFetch(`https://${PUBLIC_HOST}/import`, importOptions);
    assert.equal(imported.status, 200);
    const importReceipt = await imported.json();
    assert.ok(typeof importReceipt === "object" && importReceipt !== null && "txId" in importReceipt && "facts" in importReceipt);
    assert.equal(importReceipt.txId, importTxId);
    assert.equal(importReceipt.facts, 2);
    const replay = await active.dispatchFetch(`https://${PUBLIC_HOST}/import`, importOptions);
    assert.deepEqual(await replay.json(), importReceipt);

    await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: async (input, init) => {
      const request = new Request(input, init);
      // Local Miniflare does not emulate the account-members-only Access app.
      // Hosted login/authorization must be checked separately.
      request.headers.set("origin", "https://any-agent.example");
      return testResponse(await active.dispatchFetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body: request.method === "POST" ? await request.text() : undefined }));
    } }));
    const importedRead = await client.callTool({ name: "query", arguments: { query: `wiki:page:title(${JSON.stringify(importedEntity)}, Title), wiki:page:namespace(${JSON.stringify(importedEntity)}, Namespace)` } });
    assert.notEqual(importedRead.isError, true);
    assert.ok("content" in importedRead && importedRead.content[0]?.type === "text");
    assert.deepEqual(JSON.parse(importedRead.content[0].text).rows, [{ Title: { type: "string", value: "Import Boundary Fixture" }, Namespace: { type: "integer", value: "0" } }]);
    const observedSchema = await client.callTool({name: "get_schema", arguments: {}});
    assert.notEqual(observedSchema.isError, true);
    assert.ok("content" in observedSchema && observedSchema.content[0]?.type === "text");
    const schema = JSON.parse(observedSchema.content[0].text);
    assert.equal(schema.sequenceScope, "subtree-vector");
    assert.equal(schema.snapshotVector.length, 16);
    assert.ok(schema.fields.some((field: {field: string; valueTags: readonly string[]}) => field.field === "wiki:page:title" && field.valueTags.includes("text")));
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ["describe_dataset", "get_schema", "query"]);
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
