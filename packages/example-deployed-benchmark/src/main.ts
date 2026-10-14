import { randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = "https://poneglyph-scaleout-20261011.poneglyph.leostera.dev";
const baseUrl = (process.env["PONEGLYPH_CLOUDFLARE_URL"] ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
const passphrase = process.env["PONEGLYPH_TODO_PASSPHRASE"];
const transactionCount = boundedInteger("PONEGLYPH_CLOUDFLARE_TRANSACTIONS", 10, 2, 50);
const queryCount = boundedInteger("PONEGLYPH_CLOUDFLARE_QUERIES", 10, 2, 100);
const concurrency = boundedInteger("PONEGLYPH_CLOUDFLARE_CONCURRENCY", 2, 1, 4);
const transientStatuses = new Set([423, 429, 500, 502, 503, 520, 521, 522, 523, 524, 525, 526, 530]);

export async function main(): Promise<void> {
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".poneglyph.leostera.dev")) {
    throw new Error("Cloudflare benchmark requires HTTPS beneath *.poneglyph.leostera.dev");
  }
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new Error("PONEGLYPH_TODO_PASSPHRASE must be provided through the local shell environment");
  }

  const page = await fetch(`${baseUrl}/todo`, { signal: AbortSignal.timeout(15_000) });
  if (!page.ok || !(page.headers.get("content-type") ?? "").includes("text/html")) {
    throw new Error(`TODO demo page is unavailable (HTTP ${page.status})`);
  }
  const login = await postJson(`${baseUrl}/api/todo/login`, { passphrase });
  const setCookie = login.response.headers.get("set-cookie");
  const cookie = setCookie?.split(";", 1)[0];
  if (!login.body["authenticated"] || cookie === undefined || !cookie.startsWith("poneglyph_todo=")) {
    throw new Error("TODO login did not issue the expected authenticated session cookie");
  }

  const singleGraph = `cf-bench-${randomUUID().slice(0, 12)}`;
  const singleWrites = await benchmarkWrites(transactionCount, concurrency, async (index) => {
    const left = `bench:cloudflare:left:${index}`;
    const right = `bench:cloudflare:right:${index}`;
    return await postJson(`${baseUrl}/v1/graphs/${singleGraph}/transactions`, {
      txId: `poneglyph:tx:${singleGraph}:${index}`,
      facts: [
        fact(left, "bench:value", { type: "text", value: `value-${index}` }),
        fact(left, "bench:edge", { type: "reference", value: right }),
        fact(right, "bench:value", { type: "text", value: `value-${index}` }),
      ],
    });
  }, 3, 2);
  const singleQueries = await benchmarkQueries(singleGraph, queryCount, concurrency, undefined, [
    { shape: "full-scan", query: "bench:value(Entity, Value)" },
    { shape: "join", query: "bench:edge(From, To), bench:value(To, Value)" },
  ]);

  const todoSnapshot = await getJson(`${baseUrl}/api/todo/snapshot`, cookie);
  const taskIds: string[] = [];
  for (let index = 0; index < transactionCount; index += 1) {
    const created = await postJson(`${baseUrl}/api/todo/tasks`, {
      title: `bounded validation ${index}`,
      list: "todo:list:todo",
    }, cookie);
    if (typeof created.body["taskId"] !== "string") throw new Error("TODO task creation omitted taskId");
    taskIds.push(created.body["taskId"]);
  }

  const crossShardMoves = await benchmarkWrites(transactionCount, concurrency, async (index) => {
    const taskId = taskIds[index];
    if (taskId === undefined) throw new Error("missing validation task id");
    return await postJson(`${baseUrl}/api/todo/tasks/${taskId}/move`, { toList: "todo:list:done" }, cookie);
  }, 4, 3);
  const todoQueries = await benchmarkQueries("todo-shared-2026", queryCount, concurrency, cookie, [
    { shape: "todo-membership-scan", query: "todo:task-list(Task, List)" },
    { shape: "todo-task-join", query: "todo:task-list(Task, \"todo:list:done\"), schema:name(Task, Title)" },
  ]);
  const after = await getJson(`${baseUrl}/api/todo/snapshot`, cookie);
  const visibleTasks = Array.isArray(after.body["tasks"]) ? after.body["tasks"].length : -1;
  const beforeSeq = todoSnapshot.body["snapshotSeq"];
  const afterSeq = after.body["snapshotSeq"];
  if (typeof beforeSeq !== "number" || typeof afterSeq !== "number" || afterSeq < beforeSeq || visibleTasks < transactionCount) {
    throw new Error("post-move TODO snapshot did not expose every committed task");
  }

  console.log(JSON.stringify({
    runtime: "Cloudflare Workers / Durable Objects (isolated validation Worker)",
    endpoint: endpoint.origin,
    workload: {
      transactionsPerWorkload: transactionCount,
      queryRequestsPerWorkload: queryCount,
      concurrency,
      singleShard: { factsPerTransaction: 3, entitiesPerTransaction: 2, totalFacts: transactionCount * 3 },
      crossShardTodoMove: { factsPerTransaction: 4, touchedEntitiesPerTransaction: 3, expectedParticipants: 2, totalFacts: transactionCount * 4 },
      retryPolicy: "same body/txId for generic transaction retries; TODO route issues a fresh txId per accepted move request",
      passphrase: "set in Worker secret; never emitted by this report",
    },
    singleShard: { writes: singleWrites, queries: singleQueries },
    crossShardTodo: { writes: crossShardMoves, queries: todoQueries, visibleTaskCount: visibleTasks, snapshotSeq: afterSeq },
    caveats: [
      "Small bounded sample against one temporary Worker and a few Durable Objects; not a capacity or production SLA claim.",
      "Includes public-network, Worker, coordination, storage and response overhead; sample count is intentionally capped at 50 writes and concurrency at 4.",
      "TODO moves touch both fixed list entities, which are routed to opposite root prefixes after the demo's idempotent root split.",
    ],
  }, null, 2));
}

type JsonResult = Readonly<{ body: Record<string, unknown>; response: Response }>;
async function postJson(url: string, body: unknown, cookie?: string): Promise<JsonResult> {
  const response = await fetchWithRetry(url, JSON.stringify(body), cookie);
  const result: unknown = await response.json().catch(() => undefined);
  if (!isRecord(result)) throw new Error(`expected JSON from ${url} (HTTP ${response.status})`);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(result)}`);
  return { body: result, response };
}

async function getJson(url: string, cookie: string): Promise<JsonResult> {
  const response = await fetch(url, { headers: { cookie }, signal: AbortSignal.timeout(15_000) });
  const result: unknown = await response.json().catch(() => undefined);
  if (!isRecord(result)) throw new Error(`expected JSON from ${url} (HTTP ${response.status})`);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(result)}`);
  return { body: result, response };
}

async function fetchWithRetry(url: string, body: string, cookie?: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (!transientStatuses.has(response.status) || attempt === 7) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(250 * (attempt + 1), 1_000));
  }
  throw new Error(`request to ${url} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function benchmarkWrites(
  count: number,
  parallelism: number,
  run: (index: number) => Promise<JsonResult>,
  factsPerTransaction: number,
  entitiesPerTransaction: number,
): Promise<Record<string, unknown>> {
  const latencies: number[] = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: Math.min(parallelism, count) }, async () => {
    while (true) {
      const index = next++;
      if (index >= count) return;
      const start = performance.now();
      const result = await run(index);
      latencies.push(performance.now() - start);
      if (result.body["status"] !== undefined && result.body["status"] !== "committed") {
        throw new Error(`transaction was not committed: ${JSON.stringify(result.body)}`);
      }
    }
  }));
  const elapsedSeconds = (performance.now() - started) / 1_000;
  return {
    transactions: count,
    factsPerTransaction,
    entitiesPerTransaction,
    concurrency: parallelism,
    elapsedSeconds: round(elapsedSeconds),
    transactionsPerSecond: round(count / elapsedSeconds),
    factsPerSecond: round(count * factsPerTransaction / elapsedSeconds),
    entitiesPerSecond: round(count * entitiesPerTransaction / elapsedSeconds),
    latencyMs: summarize(latencies),
  };
}

async function benchmarkQueries(
  graphId: string,
  count: number,
  parallelism: number,
  cookie: string | undefined,
  definitions: readonly Readonly<{ shape: string; query: string }>[],
): Promise<readonly Record<string, unknown>[]> {
  const samples = new Map(definitions.map((definition) => [definition.shape, [] as number[]]));
  const costs = new Map<string, Record<string, unknown>>();
  let next = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: Math.min(parallelism, count) }, async () => {
    while (true) {
      const index = next++;
      if (index >= count) return;
      const definition = definitions[index % definitions.length];
      if (definition === undefined) throw new Error("query definition missing");
      const start = performance.now();
      const result = await postJson(`${baseUrl}/v1/graphs/${graphId}/query`, { query: definition.query }, cookie);
      const metrics = result.body["metrics"];
      if (!isRecord(metrics)) throw new Error("query response omitted execution metrics");
      (samples.get(definition.shape) ?? []).push(performance.now() - start);
      costs.set(definition.shape, metrics);
    }
  }));
  const elapsedSeconds = (performance.now() - started) / 1_000;
  return definitions.map((definition) => {
    const durations = samples.get(definition.shape) ?? [];
    return {
      shape: definition.shape,
      requests: durations.length,
      concurrency: parallelism,
      qps: round(durations.length / elapsedSeconds),
      latencyMs: summarize(durations),
      costs: costs.get(definition.shape) ?? {},
    };
  });
}

function fact(entity: string, field: string, value: Readonly<{ type: "text" | "reference"; value: string }>) {
  return { source: "fixture:cloudflare-benchmark", entity, field, value, retraction: false };
}

export function summarize(values: readonly number[]): Readonly<{ p50: number; p95: number; p99: number }> {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: round(percentile(sorted, 0.5)), p95: round(percentile(sorted, 0.95)), p99: round(percentile(sorted, 0.99)) };
}
function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}
export function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  return parsed;
}
function round(value: number): number { return Math.round(value * 100) / 100; }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
