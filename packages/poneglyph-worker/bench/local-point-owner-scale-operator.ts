import type {LocalPointOwnerDO} from "./local-point-owner-do.js";

type Env = {POINT_OWNERS: DurableObjectNamespace<LocalPointOwnerDO>; COUNT_LEVELS: number[]; RUN_ID: string};
type Sample = {keyIndex: number; elapsedMs: number; exact: boolean; errorName?: string};
const CONCURRENCY = 128;
const keyFor = (count: number, index: number) => `control:scale:${count}:key:${index.toString().padStart(4, "0")}`;
const valueFor = (index: number) => `value-${index}`;
const latency = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
  return {count: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: sorted.at(-1) ?? null};
};
async function runBounded<T>(items: readonly T[], concurrency: number, task: (item: T, index: number) => Promise<Sample>) {
  const results: Sample[] = Array(items.length);
  let cursor = 0, inFlight = 0, observedMaxInFlight = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      inFlight++;
      observedMaxInFlight = Math.max(observedMaxInFlight, inFlight);
      const started = performance.now();
      try { results[index] = await task(items[index]!, index); }
      catch (error) { results[index] = {keyIndex: index, elapsedMs: performance.now() - started,
        exact: false, errorName: error instanceof Error ? error.name : "unknown"}; }
      finally { inFlight--; }
    }
  };
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, worker));
  const exact = results.filter(sample => sample.exact);
  return {issued: items.length, completed: exact.length, failed: items.length - exact.length,
    offeredConcurrency: Math.min(concurrency, items.length), observedMaxInFlight,
    latency: latency(results.map(sample => sample.elapsedMs)), samples: results};
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST" || request.headers.has("origin") || new Set(env.COUNT_LEVELS).size !== env.COUNT_LEVELS.length ||
        env.COUNT_LEVELS.some(count => ![128, 512, 1024].includes(count))) return new Response("Not found", {status: 404});
    const path = new URL(request.url).pathname;
    if (path !== "/seed" && path !== "/read") return new Response("Not found", {status: 404});
    const phases = [];
    for (const count of env.COUNT_LEVELS) {
      const indexes = Array.from({length: count}, (_, index) => index);
      if (path === "/seed") {
        const writes = await runBounded(indexes, CONCURRENCY, async index => {
          const started = performance.now(), key = keyFor(count, index);
          const response = await env.POINT_OWNERS.getByName(key).fetch("https://point-owner.internal/write", {
            method: "POST", headers: {"content-type": "application/json"},
            body: JSON.stringify({key, value: valueFor(index), requestToken: `point-scale:${env.RUN_ID}:${count}:${index}`}),
          });
          const raw: unknown = await response.json();
          const exact = response.ok && typeof raw === "object" && raw !== null && !Array.isArray(raw) &&
            Object.keys(raw).length === 2 && (raw as Record<string, unknown>)["revision"] === 1 &&
            (raw as Record<string, unknown>)["replayed"] === false;
          return {keyIndex: index, elapsedMs: performance.now() - started, exact,
            ...(!exact ? {errorName: `write-status-${response.status}`} : {})};
        });
        phases.push({keyCount: count, writes});
      } else {
        const reads = await runBounded(indexes, CONCURRENCY, async index => {
          const started = performance.now(), key = keyFor(count, index);
          const response = await env.POINT_OWNERS.getByName(key).fetch("https://point-owner.internal/read", {
            method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({key}),
          });
          const raw: unknown = await response.json();
          const exact = response.ok && typeof raw === "object" && raw !== null && !Array.isArray(raw) &&
            Object.keys(raw).length === 3 && (raw as Record<string, unknown>)["key"] === key &&
            (raw as Record<string, unknown>)["revision"] === 1 && (raw as Record<string, unknown>)["value"] === valueFor(index);
          return {keyIndex: index, elapsedMs: performance.now() - started, exact,
            ...(!exact ? {errorName: `read-status-${response.status}`} : {})};
        });
        phases.push({keyCount: count, reads});
      }
    }
    return Response.json({runId: env.RUN_ID, architecture: "append-only point-owner DO per key",
      operation: path.slice(1), workload: "unique keys, fixed max in-flight 128, no application retries", phases});
  },
} satisfies ExportedHandler<Env>;
