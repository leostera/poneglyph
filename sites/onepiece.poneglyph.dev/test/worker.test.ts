import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "vitest";
import { build, type Plugin } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ACCESS_AUDIENCE, API_LIMITS, API_RATE_LIMIT, WRITE_RATE_LIMIT } from "../src/api.js";
import { DATASET, EXAMPLE_QUERIES, MCP_URL, PUBLIC_HOST } from "../src/dataset.js";
import { RATE_LIMIT } from "../src/rate-limit.js";
import { COMPATIBILITY_DATE, GRAPH_ID } from "../src/runtime.js";

const site = resolve(import.meta.dirname, "..");
// Stand-in for the embedded browser build (see build/client-assets.ts).
const fixtureClient: Plugin = { name: "fixture-client", setup(builder) {
  builder.onResolve({ filter: /^virtual:playground-client$/ }, () => ({ path: "client", namespace: "fixture-client" }));
  builder.onLoad({ filter: /.*/, namespace: "fixture-client" }, () => ({ loader: "js", contents: `export default ${JSON.stringify({
    "/index.html": { type: "text/html; charset=utf-8", etag: '"i"', text: "<!doctype html><div id=root></div>" },
    "/assets/app.js": { type: "text/javascript; charset=utf-8", etag: '"a"', text: "console.log(1)" },
    "/logo.png": { type: "image/png", etag: '"p"', base64: "iVBORw==" },
  })};` }));
} };
const ORIGIN = `https://${PUBLIC_HOST}`;
const luffy = "wiki:onepiece:page:Monkey%20D.%20Luffy";
const zoro = "wiki:onepiece:page:Roronoa%20Zoro";
const crew = "onepiece:crew:7802a7e4-aeb6-58c5-8999-f08deccc5902";
const SOURCE = "fixture:onepiece-playground-test";
const FIXTURE_TX = "wiki:import:fixture:playground-test:0";
const text = (value: string) => ({ type: "text", value });
const FIXTURE_FACTS = [
  { source: SOURCE, entity: luffy, field: "wiki:page:title", value: text("Monkey D. Luffy"), retraction: false },
  { source: SOURCE, entity: luffy, field: "wiki:page:category", value: text("Pirates"), retraction: false },
  { source: SOURCE, entity: luffy, field: "wiki:page:link", value: text("Roronoa Zoro"), retraction: false },
  { source: SOURCE, entity: luffy, field: "wiki:page:namespace", value: { type: "number", value: "0" }, retraction: false },
  { source: SOURCE, entity: luffy, field: "wiki:page:text_bytes", value: { type: "number", value: "140" }, retraction: false },
  { source: SOURCE, entity: zoro, field: "wiki:page:title", value: text("Roronoa Zoro"), retraction: false },
  { source: SOURCE, entity: crew, field: "onepiece:name", value: text("Straw Hat Pirates"), retraction: false },
];

async function testResponse(response: { text(): Promise<string>; status: number; headers: Iterable<[string, string]> }): Promise<Response> {
  return new Response(await response.text(), { status: response.status, headers: Object.fromEntries(response.headers) });
}
const jsonPost = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin", ...headers }, body: JSON.stringify(body),
});

// Finite native integration over real canonical SQLite actors with tiny
// fixture facts. Not a corpus load, hosted Access test or benchmark.
test("browser API, MCP and loader operator reach the canonical runtime within their boundaries", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "poneglyph-playground-test-"));
  let complete = false;
  let runtime: Miniflare | undefined;
  const client = new Client({ name: "native-playground-test", version: "1" });
  try {
    await build({ absWorkingDir: site, entryPoints: { playground: "src/index.ts", database: "../../packages/poneglyph-worker/src/index.ts", operator: "src/operator.ts" },
      outdir: directory, outExtension: { ".js": ".mjs" }, bundle: true, format: "esm", platform: "browser",
      target: "es2024", conditions: ["workerd", "worker", "browser"], external: ["cloudflare:*", "node:*"], plugins: [fixtureClient] });
    const manifest = (contents: string) => ({ mainModule: "index.mjs", modules: { "index.mjs": { type: "esm" as const, contents } } });
    const playground = manifest(await readFile(resolve(directory, "playground.mjs"), "utf8"));
    const grants = { playground: { [GRAPH_ID]: ["read"] }, "playground-writer": { [GRAPH_ID]: ["read", "write"] }, "playground-loader": { [GRAPH_ID]: ["read", "write"] } };
    const playgroundEnv = {
      PONEGLYPH: { type: "worker", worker: "database", props: { clientId: "playground" } },
      PONEGLYPH_WRITER: { type: "worker", worker: "database", props: { clientId: "playground-writer" } },
      MCP_RATE_LIMITER: { type: "rate-limit", ...RATE_LIMIT },
      API_RATE_LIMITER: { type: "rate-limit", ...API_RATE_LIMIT },
      WRITE_RATE_LIMITER: { type: "rate-limit", ...WRITE_RATE_LIMIT },
    } as const;
    runtime = new Miniflare({ port: 0, host: "127.0.0.1", resourcePersistencePath: resolve(directory, "state"),
      telemetry: { enabled: false }, log: new Log(LogLevel.WARN), workers: [
        { dev: { access: { aud: ACCESS_AUDIENCE, identity: { email: "member@example.test" } } },
          config: { name: "playground", manifest: playground, compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: ["nodejs_compat"], env: playgroundEnv } },
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
            GRAPH_GRANTS: { type: "json", value: grants },
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
        // Same public entrypoint without limiters or database: fail closed.
        { dev: { access: { aud: ACCESS_AUDIENCE, identity: { email: "member@example.test" } } },
          config: { name: "unadmitted", manifest: playground, compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: ["nodejs_compat"],
          env: { MCP_RATE_LIMITER: { type: "rate-limit", namespace: "2026101402", simple: { limit: 1, period: 60 } } } } },
      ] });
    await runtime.ready;
    const active = runtime;

    // Loader operator: loopback-only, stable IDs, idempotent same-ID replay.
    const operator = await active.getWorker("operator");
    for (const [url, init, status] of [
      ["https://onepiece.poneglyph.dev/load", { method: "POST" }, 403],
      ["http://127.0.0.1/load", { method: "POST", headers: { origin: "https://attacker.example", "content-type": "application/json" } }, 403],
      ["http://127.0.0.1/load", { method: "GET" }, 404],
      ["http://127.0.0.1/seed", { method: "POST", headers: { "content-type": "application/json" } }, 404],
    ] as const) {
      const denied = await operator.fetch(url, init); assert.equal(denied.status, status); await denied.text();
    }
    const load = () => operator.fetch("http://127.0.0.1/load", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txId: FIXTURE_TX, facts: FIXTURE_FACTS }) });
    const loaded = await (await load()).json() as Record<string, unknown>;
    assert.equal(loaded.status, "committed");
    assert.equal(loaded.txId, FIXTURE_TX);
    assert.equal(loaded.graphId, GRAPH_ID);
    const replayed = await (await load()).json() as Record<string, unknown>;
    assert.deepEqual(replayed, loaded);
    const operatorQuery = await (await operator.fetch("http://127.0.0.1/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: EXAMPLE_QUERIES[0]!.query }) })).json() as { rows: unknown[] };
    assert.deepEqual(operatorQuery.rows, [{ Page: { type: "string", value: luffy } }]);

    // Host routing and static assets with security headers.
    assert.equal((await active.dispatchFetch("https://attacker.example/")).status, 403);
    const home = await active.dispatchFetch(`${ORIGIN}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /id=root/);
    assert.match(home.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.equal(home.headers.get("x-frame-options"), "DENY");
    assert.equal(home.headers.get("cache-control"), "private, no-cache");
    assert.equal((await active.dispatchFetch(`${ORIGIN}/`, { method: "POST", body: "{}" })).status, 405);
    assert.match(await (await active.dispatchFetch(`${ORIGIN}/write`)).text(), /id=root/);
    const script = await active.dispatchFetch(`${ORIGIN}/assets/app.js`);
    assert.match(script.headers.get("cache-control") ?? "", /immutable/);
    assert.equal(await script.text(), "console.log(1)");
    assert.equal((await active.dispatchFetch(`${ORIGIN}/assets/app.js`, { headers: { "if-none-match": '"a"' } })).status, 304);
    assert.deepEqual([...new Uint8Array(await (await active.dispatchFetch(`${ORIGIN}/logo.png`)).arrayBuffer())], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal((await active.dispatchFetch(`${ORIGIN}/missing.js`)).status, 404);

    // Without a verified Access context every public route fails closed,
    // including the shell and MCP (defense in depth behind the edge app).
    const unverified = await active.getWorker("playground");
    for (const path of ["/", "/assets/app.js", "/mcp", "/api/session"]) {
      const response = await unverified.fetch(`${ORIGIN}${path}`, { method: path === "/mcp" ? "POST" : "GET", body: path === "/mcp" ? "{}" : undefined });
      assert.equal(response.status, 401, path); await response.text();
    }

    // Direct invocation carries no Access identity: the API refuses it.
    const direct = await active.getWorker("playground");
    const anonymous = await direct.fetch(`${ORIGIN}/api/session`);
    assert.equal(anonymous.status, 401); await anonymous.text();

    // HTTP ingress receives the simulated, runtime-verified Access context.
    const session = await (await active.dispatchFetch(`${ORIGIN}/api/session`, { headers: { "sec-fetch-site": "same-origin" } })).json() as Record<string, any>;
    assert.equal(session.graphId, GRAPH_ID);
    assert.equal(session.user.email, "member@example.test");
    assert.match(session.user.author, /^[0-9a-f]{16}$/);
    assert.equal(session.examples.length, EXAMPLE_QUERIES.length);
    assert.equal(session.limits.factsPerWrite, API_LIMITS.factsPerWrite);
    assert.equal(session.mcp.url, MCP_URL);
    assert.equal((await active.dispatchFetch(`${ORIGIN}/api/session`, { method: "DELETE" })).status, 405);
    assert.equal((await active.dispatchFetch(`${ORIGIN}/api/unknown`)).status, 404);
    assert.equal((await active.dispatchFetch(`${ORIGIN}/api/session?x=1`)).status, 400);

    // Browser boundary: same-origin JSON only.
    const query = (body: unknown, headers?: Record<string, string>) => active.dispatchFetch(`${ORIGIN}/api/query`, jsonPost(body, headers));
    assert.equal((await query({ query: "x" }, { origin: "https://attacker.example" })).status, 403);
    assert.equal((await query({ query: "x" }, { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await active.dispatchFetch(`${ORIGIN}/api/query`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
    assert.equal((await active.dispatchFetch(`${ORIGIN}/api/query`, jsonPost({ query: "x".repeat(API_LIMITS.requestBytes) }))).status, 413);
    assert.equal((await query({ query: "a", extra: true })).status, 400);
    const rejected = await query({ query: "this is not datalog(" });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json() as { kind: string }).kind, "rejected");

    const answered = await query({ query: EXAMPLE_QUERIES.find(example => example.id === "luffy-links")!.query });
    assert.equal(answered.status, 200);
    assert.match(answered.headers.get("server-timing") ?? "", /worker;dur=.*db;dur=/);
    const answer = await answered.json() as { rows: unknown[]; snapshotSeq: number; metrics: { shardRequests: number; timing: { executionMs: number } }; timing: { serverMs: number } };
    assert.deepEqual(answer.rows, [{ Page: { type: "string", value: luffy }, TargetTitle: { type: "string", value: "Roronoa Zoro" }, TargetPage: { type: "string", value: zoro } }]);
    assert.ok(answer.snapshotSeq >= 1);
    assert.ok(answer.metrics.shardRequests > 0);
    assert.ok(answer.timing.serverMs >= 0);

    // Writes: playground-assigned source, bounded shape, idempotent token.
    const facts = (body: unknown) => active.dispatchFetch(`${ORIGIN}/api/facts`, jsonPost(body));
    const pirate = "playground:pirate:test-1";
    const draft = [
      { entity: pirate, field: "onepiece:name", value: { type: "text", value: "Captain Test" } },
      { entity: pirate, field: "onepiece:member_of", value: { type: "reference", value: crew } },
      { entity: pirate, field: "onepiece:bounty", value: { type: "number", value: "1500000000" } },
    ];
    for (const invalid of [
      { facts: draft, requestToken: "short" },
      { facts: [], requestToken: "token-1234" },
      { facts: [{ ...draft[0], source: "wiki:onepiece:dump:forged" }], requestToken: "token-1234" },
      { facts: [{ ...draft[0], value: { type: "list", value: [] } }], requestToken: "token-1234" },
      { facts: [{ ...draft[0], value: { type: "number", value: "1.5" } }], requestToken: "token-1234" },
      { facts: Array.from({ length: API_LIMITS.factsPerWrite + 1 }, () => draft[0]), requestToken: "token-1234" },
      { facts: [{ ...draft[0], entity: "not a uri" }], requestToken: "token-1234" },
    ]) {
      const response = await facts(invalid);
      assert.equal(response.status, 400, JSON.stringify(invalid).slice(0, 120));
      assert.notEqual((await response.json() as { delivery: string }).delivery, "unknown");
    }
    const committed = await facts({ facts: draft, requestToken: "token-1234" });
    assert.equal(committed.status, 200);
    const receipt = await committed.json() as { txId: string; facts: { source?: string }[] };
    assert.match(receipt.txId, /^poneglyph:tx:/);
    const retry = await (await facts({ facts: draft, requestToken: "token-1234" })).json() as { txId: string };
    assert.equal(retry.txId, receipt.txId);
    const readBack = await (await query({ query: `onepiece:name(Crew, "Straw Hat Pirates"), onepiece:member_of(Member, Crew), onepiece:name(Member, Name), onepiece:bounty(Member, Bounty)` })).json() as { rows: unknown[] };
    assert.deepEqual(readBack.rows, [{ Crew: { type: "string", value: crew }, Member: { type: "string", value: pirate }, Name: { type: "string", value: "Captain Test" }, Bounty: { type: "integer", value: "1500000000" } }]);
    const retracted = await facts({ facts: [{ ...draft[2], retraction: true }], requestToken: "token-5678" });
    assert.equal(retracted.status, 200);
    const afterRetraction = await (await query({ query: `onepiece:bounty(${JSON.stringify(pirate)}, Bounty)` })).json() as { rows: unknown[] };
    assert.deepEqual(afterRetraction.rows, []);

    const schema = await (await active.dispatchFetch(`${ORIGIN}/api/schema`)).json() as { schema: { fields: { field: string }[] } };
    assert.ok(schema.schema.fields.some(field => field.field === "onepiece:member_of"));

    // Direct invocations of a second deployment still have no identity.
    const unadmittedWorker = await active.getWorker("unadmitted");
    const noAccess = await unadmittedWorker.fetch(`${ORIGIN}/api/session`);
    assert.equal(noAccess.status, 401); await noAccess.text();

    // MCP stays read-only on the same graph.
    await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: async (input, init) => {
      const request = new Request(input, init);
      request.headers.set("origin", "https://any-agent.example");
      return testResponse(await active.dispatchFetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body: request.method === "POST" ? await request.text() : undefined }));
    } }));
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ["describe_dataset", "get_schema", "query"]);
    const described = await client.callTool({ name: "describe_dataset", arguments: {} });
    assert.ok("content" in described && described.content[0]?.type === "text");
    assert.equal(JSON.parse(described.content[0].text).graphId, GRAPH_ID);
    const mcpAnswer = await client.callTool({ name: "query", arguments: { query: DATASET.examples[0] } });
    assert.ok("content" in mcpAnswer && mcpAnswer.content[0]?.type === "text");
    assert.deepEqual(JSON.parse(mcpAnswer.content[0].text).rows, [{ Page: { type: "string", value: luffy } }]);
    const batched = await active.dispatchFetch(MCP_URL, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query", arguments: { query: DATASET.examples[0] } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "query", arguments: { query: DATASET.examples[0] } } },
    ]) });
    assert.equal(batched.status, 400); await batched.text();
    const preflight = await active.dispatchFetch(MCP_URL, { method: "OPTIONS", headers: { origin: "https://any-agent.example" } });
    assert.equal(preflight.status, 204);
    const limited = await active.getWorker("unadmitted");
    const first = await limited.fetch("http://127.0.0.1/mcp", { method: "POST", body: "{}" });
    assert.equal(first.status, 503); await first.text();
    const denied = await limited.fetch("http://127.0.0.1/mcp", { method: "POST", body: "{}" });
    assert.equal(denied.status, 429); await denied.text();
    complete = true;
  } finally {
    await client.close();
    if (runtime !== undefined) await runtime.dispose();
    if (complete) await rm(directory, { recursive: true, force: true });
    else console.error(JSON.stringify({ event: "incomplete-playground-test", directory }));
  }
});
