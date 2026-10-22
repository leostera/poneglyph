import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "vitest";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import { GRAPH_SCOPES, COMPATIBILITY_DATE, GRAPH_HEADER, HOST } from "../src/registry.js";
import { memorybenchGrants } from "../../../packages/poneglyph-worker/memorybench-grants.js";

const site = resolve(import.meta.dirname, "..");
const audience = "fixture-memorybench-audience";
const scopeA = [...GRAPH_SCOPES.values()].find(s => s.benchmark === "locomo" && s.variant === "a")!;
const scopeB = [...GRAPH_SCOPES.values()].find(s => s.benchmark === "locomo" && s.variant === "b")!;
const post = (body: unknown, graph = scopeA.graphId) => ({ method: "POST", headers: { "content-type": "application/json", [GRAPH_HEADER]: graph }, body: JSON.stringify(body) });

// Real canonical SQLite actors, not an HTTP mock. No account/cloud/model calls.
test("isolated read-only MCP and idempotent loopback ingestion", async () => {
  assert.equal(GRAPH_SCOPES.size, 1020);
  assert.deepEqual(Object.keys(memorybenchGrants["memorybench-reader"]).sort(), [...GRAPH_SCOPES.keys()].sort());
  const directory = await mkdtemp(resolve(tmpdir(), "memorybench-native-"));
  let runtime: Miniflare | undefined;
  let complete = false;
  try {
    await build({ absWorkingDir: site, entryPoints: { site: "src/index.ts", operator: "src/operator.ts", database: "../../packages/poneglyph-worker/src/index.ts" },
      outdir: directory, outExtension: { ".js": ".mjs" }, bundle: true, format: "esm", platform: "browser", target: "es2024",
      conditions: ["workerd", "worker", "browser"], external: ["cloudflare:*", "node:*"] });
    const manifest = async (name: string) => ({ mainModule: "index.mjs", modules: { "index.mjs": { type: "esm" as const, contents: await readFile(resolve(directory, `${name}.mjs`), "utf8") } } });
    const publicManifest = await manifest("site");
    const base = { compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: ["nodejs_compat"] };
    const publicEnv = {
      ACCESS_AUDIENCE: { type: "json", value: audience },
      PONEGLYPH: { type: "worker", worker: "database", props: { clientId: "memorybench-reader" } },
      MCP_RATE_LIMITER: { type: "rate-limit", namespace: "2026102201", simple: { limit: 600, period: 60 } },
    } as const;
    const access = { aud: audience, identity: { email: "member@example.test" } };
    runtime = new Miniflare({ port: 0, host: "127.0.0.1", resourcePersistencePath: resolve(directory, "state"), telemetry: { enabled: false }, log: new Log(LogLevel.WARN), workers: [
      { dev: { access }, config: { ...base, name: "site", manifest: publicManifest, env: publicEnv } },
      { config: { ...base, name: "anonymous", manifest: publicManifest, env: publicEnv } },
      { config: { ...base, name: "operator", manifest: await manifest("operator"), env: { PONEGLYPH: { type: "worker", worker: "database", props: { clientId: "memorybench-loader" } } } } },
      { config: { ...base, name: "database", manifest: await manifest("database"), env: {
        GRAPH_GRANTS: { type: "json", value: memorybenchGrants },
        GRAPH_FACADES: { type: "durable-object", worker: "database", exportName: "GraphCoordinatorDO" },
        GRAPH_LEDGERS: { type: "durable-object", worker: "database", exportName: "GraphLedgerDO" },
        GRAPH_TREES: { type: "durable-object", worker: "database", exportName: "GraphTreeDO" },
        GRAPH_SHARDS: { type: "durable-object", worker: "database", exportName: "GraphShardDO" },
      }, exports: {
        GraphCoordinatorDO: { type: "durable-object", storage: "sqlite" }, GraphLedgerDO: { type: "durable-object", storage: "sqlite" },
        GraphTreeDO: { type: "durable-object", storage: "sqlite" }, GraphShardDO: { type: "durable-object", storage: "sqlite" },
      } } },
    ] });
    await runtime.ready;
    // Only ingress dispatch applies Miniflare's verified Access simulation;
    // getWorker() is an internal binding and deliberately has no Access identity.
    const publicWorker = { fetch: runtime.dispatchFetch.bind(runtime) };
    const operator = await runtime.getWorker("operator");
    const anonymous = await runtime.getWorker("anonymous");
    for (const path of ["/", "/mcp", "/load"]) assert.equal((await anonymous.fetch(`https://${HOST}${path}`)).status, 401);
    assert.equal((await publicWorker.fetch(`https://${HOST}/load`, post({}))).status, 404);
    assert.equal((await publicWorker.fetch(`https://${HOST}/mcp`, post({}, "onepiece-wiki"))).status, 403);
    assert.equal((await publicWorker.fetch(`https://${HOST}/mcp`, { ...post({}), headers: { ...post({}).headers, origin: "https://attacker.test" } })).status, 403);
    assert.equal((await operator.fetch(`https://${HOST}/load`, post({}))).status, 403);
    assert.equal((await operator.fetch("http://127.0.0.1/load", { ...post({}), headers: { ...post({}).headers, origin: "http://localhost" } })).status, 403);
    assert.equal((await operator.fetch("http://127.0.0.1/load", post({}, "onepiece-wiki"))).status, 403);
    assert.equal((await operator.fetch("http://127.0.0.1/load", post({}))).status, 400);
    for (const [scope, content] of [[scopeA, "alice-only"], [scopeB, "bob-only"]] as const) {
      const facts = [{ source: `memorybench:${scope.datasetHash}:${scope.variant}`, entity: "memory:fixture:message", field: "memory:text", value: { type: "text", value: content }, retraction: false }];
      const body = { txId: `memorybench:${scope.graphId}:fixture:0`, facts };
      const first = await (await operator.fetch("http://127.0.0.1/load", post(body, scope.graphId))).json() as { status: string };
      assert.equal(first.status, "committed");
      assert.deepEqual(await (await operator.fetch("http://127.0.0.1/load", post(body, scope.graphId))).json(), first);
    }
    async function rpc(method: string, params: unknown, graph = scopeA.graphId) {
      const response = await publicWorker.fetch(`https://${HOST}/mcp`, { ...post({ jsonrpc: "2.0", id: 1, method, params }, graph), headers: { ...post({}).headers, [GRAPH_HEADER]: graph, accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" } });
      assert.equal(response.status, 200);
      const body = await response.text();
      const data = body.startsWith("{") ? body : body.split("\n").find(line => line.startsWith("data: "))?.slice(6);
      assert.ok(data, body);
      return JSON.parse(data) as { result: { tools?: { name: string }[]; content?: { text: string }[] }; error?: unknown };
    }
    const tools = await rpc("tools/list", {});
    assert.deepEqual(tools.result.tools?.map(t => t.name).sort(), ["describe_dataset", "get_schema", "query"]);
    for (const [scope, content] of [[scopeA, "alice-only"], [scopeB, "bob-only"]] as const) {
      // No filtering: graph scope alone must exclude the neighboring dataset.
      const answer = await rpc("tools/call", { name: "query", arguments: { query: "memory:text(Message, Text)" } }, scope.graphId);
      const result = JSON.parse(answer.result.content![0]!.text) as { rows: unknown[] };
      assert.deepEqual(result.rows, [{ Message: { type: "string", value: "memory:fixture:message" }, Text: { type: "string", value: content } }]);
    }
    const forbidden = await rpc("tools/call", { name: "transact", arguments: {} });
    assert.ok(forbidden.error);
    complete = true;
  } finally {
    await runtime?.dispose();
    if (complete) await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
