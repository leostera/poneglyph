import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { coordinatorObjectName, prefixOfKey, virtualKeyForEntity } from "../src/storage/keys.js";

const RUN_BENCHMARK = (env as unknown as { PONEGLYPH_RUN_BENCH?: string }).PONEGLYPH_RUN_BENCH === "1";
const transactionCount = boundedInteger("PONEGLYPH_BENCH_TRANSACTIONS", 40, 4, 500);
const queryCount = boundedInteger("PONEGLYPH_BENCH_QUERIES", 40, 4, 2_000);
const concurrency = boundedInteger("PONEGLYPH_BENCH_CONCURRENCY", 4, 1, 16);

type InputFact = Readonly<{
  source: string;
  entity: string;
  field: string;
  value: Readonly<{ type: "text" | "reference"; value: string }>;
  retraction: false;
}>;
type RunResult = Readonly<{
  name: string;
  graphId: string;
  transactions: number;
  factsPerTransaction: number;
  entitiesPerTransaction: number;
  writeConcurrency: number;
  writes: Readonly<{ txPerSecond: number; factsPerSecond: number; entitiesPerSecond: number; latencyMs: ReturnType<typeof latencySummary> }>;
  queryConcurrency: number;
  queries: readonly Readonly<{ shape: string; qps: number; latencyMs: ReturnType<typeof latencySummary>; costs: Record<string, unknown> }>[];
}>;

describe.skipIf(!RUN_BENCHMARK)("repeatable local throughput benchmark", () => {
  it("measures single-leaf and cross-leaf commits plus distributed query costs", async () => {
    const singleGraph = `bench-single-${crypto.randomUUID()}`;
    const crossGraph = `bench-cross-${crypto.randomUUID()}`;
    const single = await measureWorkload("single-leaf", singleGraph, false);
    const cross = await measureWorkload("cross-leaf", crossGraph, true);
    console.log(JSON.stringify({
      runtime: "local workerd (Miniflare)",
      workload: {
        transactionsPerMode: transactionCount,
        factsPerTransaction: 3,
        entitiesPerTransaction: 2,
        queryRepetitions: queryCount,
        writeConcurrency: concurrency,
        queryConcurrency: concurrency,
        retryPolicy: "same txId/payload; bounded exponential backoff on coordinator busy responses",
      },
      results: [single, cross],
      caveat: "Local workerd results are repeatability evidence only; they are not Cloudflare production capacity or latency guarantees.",
    }, null, 2));
    expect(single.transactions).toBe(transactionCount);
    expect(cross.transactions).toBe(transactionCount);
  }, 120_000);
});

async function measureWorkload(name: string, graphId: string, split: boolean): Promise<RunResult> {
  if (split) {
    const coordinator = env.GRAPH_COORDINATORS.getByName(coordinatorObjectName(graphId));
    const response = await coordinator.fetch("https://coordinator.internal/_split", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ graphId, prefix: "", force: true }),
    });
    if (!response.ok) throw new Error(`benchmark split failed: ${response.status} ${await response.text()}`);
  }

  const entityPairs = split ? await findCrossShardEntityPairs(graphId, transactionCount) :
    Array.from({ length: transactionCount }, (_, index) => [`bench:single:left:${index}`, `bench:single:right:${index}`] as const);
  const writeSamples: number[] = [];
  const startedWrites = performance.now();
  let nextTransaction = 0;
  const writers = Array.from({ length: Math.min(concurrency, transactionCount) }, async () => {
    while (true) {
      const index = nextTransaction++;
      if (index >= transactionCount) return;
      const [left, right] = entityPairs[index] ?? [];
      if (left === undefined || right === undefined) throw new Error("missing benchmark entity pair");
      const batch = {
        txId: `poneglyph:tx:${graphId}:${index}`,
        facts: [
          fact(left, "bench:value", { type: "text", value: `value-${index}` }),
          fact(left, "bench:edge", { type: "reference", value: right }),
          fact(right, "bench:value", { type: "text", value: `value-${index}` }),
        ],
      };
      const latency = await retryWrite(graphId, batch);
      writeSamples.push(latency);
    }
  });
  await Promise.all(writers);
  const writeElapsedSeconds = (performance.now() - startedWrites) / 1_000;
  const queryDefs = [
    { shape: "full-scan", query: "bench:value(Entity, Value)" },
    { shape: "join", query: "bench:edge(From, To), bench:value(To, Value)" },
  ] as const;
  const querySamples = new Map<string, number[]>();
  const queryCosts = new Map<string, Record<string, unknown>>();
  for (const query of queryDefs) querySamples.set(query.shape, []);
  let nextQuery = 0;
  const startedQueries = performance.now();
  const readers = Array.from({ length: Math.min(concurrency, queryCount) }, async () => {
    while (true) {
      const index = nextQuery++;
      if (index >= queryCount) return;
      const definition = queryDefs[index % queryDefs.length];
      if (definition === undefined) throw new Error("missing benchmark query definition");
      const started = performance.now();
      const body = await runQuery(graphId, definition.query);
      (querySamples.get(definition.shape) ?? []).push(performance.now() - started);
      if (!isRecord(body["metrics"])) throw new Error("query response did not contain metrics");
      queryCosts.set(definition.shape, body["metrics"]);
    }
  });
  await Promise.all(readers);
  const queryElapsedSeconds = (performance.now() - startedQueries) / 1_000;

  return {
    name,
    graphId,
    transactions: transactionCount,
    factsPerTransaction: 3,
    entitiesPerTransaction: 2,
    writeConcurrency: concurrency,
    writes: {
      txPerSecond: round(transactionCount / writeElapsedSeconds),
      factsPerSecond: round(transactionCount * 3 / writeElapsedSeconds),
      entitiesPerSecond: round(transactionCount * 2 / writeElapsedSeconds),
      latencyMs: latencySummary(writeSamples),
    },
    queryConcurrency: concurrency,
    queries: queryDefs.map((query) => {
      const samples = querySamples.get(query.shape) ?? [];
      return {
        shape: query.shape,
        qps: round(samples.length / queryElapsedSeconds),
        latencyMs: latencySummary(samples),
        costs: queryCosts.get(query.shape) ?? {},
      };
    }),
  };
}

async function retryWrite(graphId: string, batch: Readonly<{ txId: string; facts: readonly InputFact[] }>): Promise<number> {
  const payload = JSON.stringify(batch);
  const started = performance.now();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await exports.default.fetch(new Request(`https://poneglyph.test/v1/graphs/${graphId}/transactions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: payload,
    }));
    if (response.ok) {
      const result: unknown = await response.json();
      if (!isRecord(result) || result["txId"] !== batch.txId || result["status"] !== "committed") {
        throw new Error(`unexpected benchmark transaction outcome: ${JSON.stringify(result)}`);
      }
      return performance.now() - started;
    }
    const detail = await response.text();
    if (response.status !== 423 && response.status < 500) throw new Error(`benchmark write rejected (${response.status}): ${detail}`);
    await delay(Math.min(1 + attempt, 20));
  }
  throw new Error(`transaction ${batch.txId} did not commit after bounded retries`);
}

async function runQuery(graphId: string, query: string): Promise<Record<string, unknown>> {
  const response = await exports.default.fetch(new Request(`https://poneglyph.test/v1/graphs/${graphId}/query`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }),
  }));
  const result: unknown = await response.json();
  if (!response.ok || !isRecord(result)) throw new Error(`benchmark query rejected (${response.status}): ${JSON.stringify(result)}`);
  return result;
}

async function findCrossShardEntityPairs(graphId: string, count: number): Promise<readonly (readonly [string, string])[]> {
  const pairs: (readonly [string, string])[] = [];
  for (let index = 0; index < count; index += 1) {
    const left = `bench:cross:left:${index}`;
    const leftPrefix = prefixOfKey(await virtualKeyForEntity(graphId, left), 1);
    let right: string | undefined;
    for (let candidate = index; candidate < index + 256; candidate += 1) {
      const proposed = `bench:cross:right:${candidate}`;
      if (prefixOfKey(await virtualKeyForEntity(graphId, proposed), 1) !== leftPrefix) {
        right = proposed;
        break;
      }
    }
    if (right === undefined) throw new Error("could not find an entity in the other root split branch");
    pairs.push([left, right]);
  }
  return pairs;
}

function fact(entity: string, field: string, value: Readonly<{ type: "text" | "reference"; value: string }>): InputFact {
  return { source: "fixture:throughput-benchmark", entity, field, value, retraction: false };
}

function latencySummary(values: readonly number[]): Readonly<{ p50: number; p95: number; p99: number }> {
  const sorted = [...values].sort((left, right) => left - right);
  return { p50: round(percentile(sorted, 0.5)), p95: round(percentile(sorted, 0.95)), p99: round(percentile(sorted, 0.99)) };
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function round(value: number): number { return Math.round(value * 100) / 100; }
function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
