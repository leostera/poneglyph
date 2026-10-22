// Explicit offline integration, never a default build hook or benchmark score.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { PoneglyphProvider } from "../bench/provider.js";
import { MODEL, type ModelClient } from "../bench/model.js";
import { retrieve } from "../bench/retrieve.js";
import { Store } from "../bench/store.js";
import { GRAPH_SCOPES, COMPATIBILITY_DATE, GRAPH_HEADER, HOST } from "../src/registry.js";
import { splitGrantBindings } from "../../../packages/poneglyph-worker/src/grant-bindings.js";
import { memorybenchGrants } from "../../../packages/poneglyph-worker/memorybench-grants.js";
if (!process.argv[2]) throw new Error("Usage: tsx scripts/local-pipeline.ts PINNED_PATCHED_CHECKOUT");
const checkout = resolve(process.argv[2]);
const originalDirectory = process.cwd();
const upstream = (path: string) => import(pathToFileURL(resolve(checkout, `src/${path}.ts`)).href);
const temporary = await mkdtemp(join(tmpdir(), "memorybench-pipeline-"));
const site = resolve(import.meta.dirname, "..");
const originalFetch = globalThis.fetch;
let runtime: Miniflare | undefined;
let modelRequests = 0;
try {
  process.env.MEMORYBENCH_STATE_DIR = join(temporary, "adapter");
  process.env.MEMORYBENCH_CF_ACCOUNT_ID = "0".repeat(32);
  process.env.MEMORYBENCH_CF_TOKEN_FILE = join(temporary, "fixture-token");
  await writeFile(process.env.MEMORYBENCH_CF_TOKEN_FILE, "offline-fixture-not-a-credential", { mode: 0o600 });
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, "api.cloudflare.com", "Offline model fixture must never forward network requests");
    assert.equal(url.pathname, `/client/v4/accounts/${"0".repeat(32)}/ai/v1/responses`);
    const body = String(init?.body);
    const text = body.includes("EXPECTED ANSWER") ? '[{"id":"result_1","relevant":1}]' : body.includes("Hypothesis") || body.includes("hypothesis") ? '{"score":1,"label":"correct","explanation":"offline fixture"}' : "Oslo";
    modelRequests++;
    return Response.json({ id: `resp_fixture_${modelRequests}`, object: "response", created_at: 1, model: MODEL, status: "completed", error: null, incomplete_details: null,
      output: [{ id: `msg_${modelRequests}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } });
  };
  await build({ absWorkingDir: site, entryPoints: { site: "src/index.ts", operator: "src/operator.ts", database: "../../packages/poneglyph-worker/src/index.ts" }, outdir: temporary, outExtension: { ".js": ".mjs" }, bundle: true, format: "esm", platform: "browser", target: "es2024", conditions: ["workerd", "worker", "browser"], external: ["cloudflare:*", "node:*"] });
  const manifest = async (name: string) => ({ mainModule: "index.mjs", modules: { "index.mjs": { type: "esm" as const, contents: await readFile(join(temporary, `${name}.mjs`), "utf8") } } });
  const base = { compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: ["nodejs_compat"] };
  runtime = new Miniflare({ port: 0, host: "127.0.0.1", resourcePersistencePath: join(temporary, "sqlite"), telemetry: { enabled: false }, log: new Log(LogLevel.WARN), workers: [
    { dev: { access: { aud: "fixture-access", identity: { email: "fixture@example.test" } } }, config: { ...base, name: "site", manifest: await manifest("site"), env: { ACCESS_AUDIENCE: { type: "json", value: "fixture-access" }, PONEGLYPH: { type: "worker", worker: "database", props: { clientId: "memorybench-reader" } }, MCP_RATE_LIMITER: { type: "rate-limit", namespace: "2026102201", simple: { limit: 600, period: 60 } } } } },
    { config: { ...base, name: "operator", manifest: await manifest("operator"), env: { PONEGLYPH: { type: "worker", worker: "database", props: { clientId: "memorybench-loader" } } } } },
    { config: { ...base, name: "database", manifest: await manifest("database"), env: {
      ...Object.fromEntries(Object.entries(splitGrantBindings(memorybenchGrants)).map(([key, value]) => [key, { type: "json" as const, value }])), GRAPH_FACADES: { type: "durable-object", worker: "database", exportName: "GraphCoordinatorDO" }, GRAPH_LEDGERS: { type: "durable-object", worker: "database", exportName: "GraphLedgerDO" }, GRAPH_TREES: { type: "durable-object", worker: "database", exportName: "GraphTreeDO" }, GRAPH_SHARDS: { type: "durable-object", worker: "database", exportName: "GraphShardDO" },
    }, exports: { GraphCoordinatorDO: { type: "durable-object", storage: "sqlite" }, GraphLedgerDO: { type: "durable-object", storage: "sqlite" }, GraphTreeDO: { type: "durable-object", storage: "sqlite" }, GraphShardDO: { type: "durable-object", storage: "sqlite" } } } },
  ] });
  await runtime.ready;
  const active = runtime;
  const operator = await active.getWorker("operator");
  const model: ModelClient = { async complete(role, messages) {
    if (role === "extraction") {
      const input = JSON.parse(String(messages[1]!.content)) as { messages: { id: string }[] };
      return { content: JSON.stringify([{ subject: "Alice", predicate: "lives in", object: "Oslo", evidence: [input.messages[0]!.id] }]), calls: [], raw: {} };
    }
    const toolMessages = messages.filter(m => m.role === "tool").length;
    const names = toolMessages === 0 ? ["describe_dataset", "get_schema"] : toolMessages === 2 ? ["query"] : [];
    return { content: names.length ? "" : '{"evidence":[{"call":0,"row":0}]}', calls: names.map((name, index) => ({ id: `fixture_${toolMessages}_${index}`, name, arguments: JSON.stringify(name === "query" ? { query: "memory:text(Message, Text)" } : {}) })), raw: {} };
  } };
  const connect = async (graph: string) => {
    const client = new Client({ name: "offline-pipeline", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`https://${HOST}/mcp`), { requestInit: { headers: { [GRAPH_HEADER]: graph } }, fetch: async (input, init) => {
      const request = new Request(input, init);
      const result = await active.dispatchFetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body: request.body ? await request.text() : undefined });
      return new Response(await result.text(), { status: result.status, headers: Object.fromEntries(result.headers) });
    } }));
    return client;
  };
  process.chdir(temporary); // upstream report paths must stay in this owned fixture directory
  const { CheckpointManager } = await upstream("orchestrator/checkpoint");
  const { runIngestPhase } = await upstream("orchestrator/phases/ingest");
  const { runIndexingPhase } = await upstream("orchestrator/phases/indexing");
  const { runSearchPhase } = await upstream("orchestrator/phases/search");
  const { runAnswerPhase } = await upstream("orchestrator/phases/answer");
  const { runEvaluatePhase } = await upstream("orchestrator/phases/evaluate");
  const { generateReport } = await upstream("orchestrator/phases/report");
  const { OpenAIJudge } = await upstream("judges/openai");
  for (const benchmarkName of ["locomo", "longmemeval"] as const) for (const variant of ["a", "b"] as const) {
    const scope = [...GRAPH_SCOPES.values()].find(s => s.benchmark === benchmarkName && s.variant === variant)!;
    const runId = `offline-${benchmarkName}-${variant}`;
    const question = { questionId: "fixture-question", question: "Where does Alice live?", questionType: "single-hop", groundTruth: "Oslo", haystackSessionIds: ["fixture-session"] };
    const benchmark = { name: benchmarkName, async load() {}, getQuestions: () => [question], getHaystackSessions: () => [{ sessionId: "fixture-session", messages: [{ role: "user" as const, content: "Alice lives in Oslo." }] }], getGroundTruth: () => "Oslo", getQuestionTypes: () => ({}) };
    class LocalProvider extends PoneglyphProvider {
      override async search(query: string, options: { containerTag: string; limit?: number }) {
        assert.equal(options.containerTag, `${scope.container}-${runId}`);
        return retrieve(model, new Store(join(temporary, "retrieval")), scope.graphId, query, options.limit ?? 10, connect);
      }
    }
    const provider = new LocalProvider(variant, model, async (input, init) => {
      const request = new Request(input, init);
      const result = await operator.fetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() });
      return new Response(await result.text(), { status: result.status, headers: Object.fromEntries(result.headers) });
    });
    await provider.initialize({ apiKey: "", benchmark: benchmarkName, dataSourceRunId: runId });
    const manager = new CheckpointManager(join(temporary, "runs"));
    const checkpoint = manager.create(runId, provider.name, benchmarkName, MODEL, MODEL);
    manager.initQuestion(checkpoint, question.questionId, `${scope.container}-${runId}`, question);
    await runIngestPhase(provider, benchmark, checkpoint, manager);
    await runIndexingPhase(provider, checkpoint, manager);
    await runSearchPhase(provider, benchmark, checkpoint, manager);
    await runAnswerPhase(benchmark, checkpoint, manager, undefined, provider);
    const judge = new OpenAIJudge();
    await judge.initialize({ apiKey: "", model: MODEL });
    await runEvaluatePhase(judge, benchmark, checkpoint, manager, undefined, provider);
    await manager.flush();
    for (const phase of ["ingest", "indexing", "search", "answer", "evaluate"]) assert.equal(checkpoint.questions[question.questionId].phases[phase].status, "completed");
    const report = generateReport(benchmark, checkpoint);
    assert.ok(report);
    console.log(JSON.stringify({ fixtureOnly: true, runId, pipeline: "all phases completed", realSqlite: true, realMcp: true, models: "scripted offline fixtures, not benchmark scores" }));
  }
  assert.ok(modelRequests >= 8);
} finally {
  globalThis.fetch = originalFetch;
  process.chdir(originalDirectory);
  await runtime?.dispose();
  await rm(temporary, { recursive: true, force: true });
}
