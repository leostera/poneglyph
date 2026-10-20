import type {LocalPointBucketDO} from "./local-point-bucket-do.js";

type Env = {BUCKETS: DurableObjectNamespace<LocalPointBucketDO>; PARTITION_COUNTS: number[]; RUN_ID: string};
type Sample = {keyIndex: number; elapsedMs: number; exact: boolean; errorName?: string};
const TENANT_COUNT = 128, CONCURRENCY = 128;
const keyFor = (count: number, index: number) => `control:bucket:${count}:key:${index.toString().padStart(3, "0")}`;
const bucketName = (count: number, index: number) => `control-bucket-${count}-${index % count}`;
const valueFor = (index: number) => `value-${index}`;
const latency = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
  return {count: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: sorted.at(-1) ?? null};
};
async function runBounded(items: readonly number[], task: (index: number, started: number) => Promise<Sample>) {
  const results: Sample[] = Array(items.length);
  let cursor = 0, inFlight = 0, observedMaxInFlight = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = items[cursor++]!;
      inFlight++;
      observedMaxInFlight = Math.max(observedMaxInFlight, inFlight);
      const started = performance.now();
      try { results[index] = await task(index, started); }
      catch (error) { results[index] = {keyIndex: index, elapsedMs: performance.now() - started,
        exact: false, errorName: error instanceof Error ? error.name : "unknown"}; }
      finally { inFlight--; }
    }
  };
  await Promise.all(Array.from({length: Math.min(CONCURRENCY, items.length)}, worker));
  const exact = results.filter(sample => sample.exact);
  return {issued: items.length, completed: exact.length, failed: items.length - exact.length,
    offeredConcurrency: Math.min(CONCURRENCY, items.length), observedMaxInFlight,
    latency: latency(results.map(sample => sample.elapsedMs)), samples: results};
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST" || request.headers.has("origin") ||
        JSON.stringify(env.PARTITION_COUNTS) !== JSON.stringify([1, 2, 4, 8, 16, 32, 64, 128])) {
      return new Response("Not found", {status: 404});
    }
    const path = new URL(request.url).pathname;
    if (path !== "/seed" && path !== "/read") return new Response("Not found", {status: 404});
    const phases = [];
    for (const count of env.PARTITION_COUNTS) {
      const indexes = Array.from({length: TENANT_COUNT}, (_, index) => index);
      const measurement = await runBounded(indexes, async (index, started) => {
        const key = keyFor(count, index), bucket = env.BUCKETS.getByName(bucketName(count, index));
        const response = path === "/seed"
          ? await bucket.fetch("https://point-bucket.internal/write", {method: "POST", headers: {"content-type": "application/json"},
              body: JSON.stringify({key, value: valueFor(index), requestToken: `bucket:${env.RUN_ID}:${count}:${index}`})})
          : await bucket.fetch("https://point-bucket.internal/read", {method: "POST", headers: {"content-type": "application/json"},
              body: JSON.stringify({key})});
        const raw: unknown = await response.json();
        const expectedKeys = path === "/seed" ? 2 : 3;
        const exact = response.ok && typeof raw === "object" && raw !== null && !Array.isArray(raw) &&
          Object.keys(raw).length === expectedKeys && (raw as Record<string, unknown>)["revision"] === 1 &&
          (path === "/seed" ? (raw as Record<string, unknown>)["replayed"] === false :
            (raw as Record<string, unknown>)["key"] === key && (raw as Record<string, unknown>)["value"] === valueFor(index));
        return {keyIndex: index, elapsedMs: performance.now() - started, exact,
          ...(!exact ? {errorName: `status-${response.status}`} : {})};
      });
      phases.push({partitionCount: count, bucketCount: count, requestCount: TENANT_COUNT, measurement});
    }
    return Response.json({runId: env.RUN_ID, operation: path.slice(1),
      architecture: "hash-partitioned append-only key-owner Durable Objects",
      workload: "128 independent keys, one request per key, fixed offered concurrency 128, no retries", phases});
  },
} satisfies ExportedHandler<Env>;
