import type {LocalPointBucketDO} from "./local-point-bucket-do.js";

type Layout = {keyCount: number; partitionCounts: number[]};
type Env = {BUCKETS: DurableObjectNamespace<LocalPointBucketDO>; LAYOUTS: Layout[]; RUN_ID: string};
type Sample = {keyIndex: number; elapsedMs: number; exact: boolean; errorName?: string};
const CONCURRENCY = 128;
const keyFor = (keyCount: number, index: number) => `control:bucket-scale:${keyCount}:key:${index.toString().padStart(4, "0")}`;
const bucketName = (keyCount: number, partitionCount: number, index: number) =>
  `control-bucket-${keyCount}-${partitionCount}-${index % partitionCount}`;
const valueFor = (index: number) => `value-${index}`;
const latency = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
  return {count: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: sorted.at(-1) ?? null};
};
async function measure(keyCount: number, partitionCount: number, operation: "seed" | "read", env: Env) {
  const results: Sample[] = Array(keyCount);
  let cursor = 0, inFlight = 0, observedMaxInFlight = 0;
  const worker = async () => {
    while (cursor < keyCount) {
      const index = cursor++;
      inFlight++;
      observedMaxInFlight = Math.max(observedMaxInFlight, inFlight);
      const started = performance.now();
      try {
        const key = keyFor(keyCount, index), bucket = env.BUCKETS.getByName(bucketName(keyCount, partitionCount, index));
        const response = operation === "seed"
          ? await bucket.fetch("https://point-bucket.internal/write", {method: "POST", headers: {"content-type": "application/json"},
              body: JSON.stringify({key, value: valueFor(index), requestToken: `bucket-scale:${env.RUN_ID}:${keyCount}:${partitionCount}:${index}`})})
          : await bucket.fetch("https://point-bucket.internal/read", {method: "POST", headers: {"content-type": "application/json"},
              body: JSON.stringify({key})});
        const raw: unknown = await response.json();
        const expectedKeys = operation === "seed" ? 2 : 3;
        const exact = response.ok && typeof raw === "object" && raw !== null && !Array.isArray(raw) &&
          Object.keys(raw).length === expectedKeys && (raw as Record<string, unknown>)["revision"] === 1 &&
          (operation === "seed" ? (raw as Record<string, unknown>)["replayed"] === false :
            (raw as Record<string, unknown>)["key"] === key && (raw as Record<string, unknown>)["value"] === valueFor(index));
        results[index] = {keyIndex: index, elapsedMs: performance.now() - started, exact,
          ...(!exact ? {errorName: `status-${response.status}`} : {})};
      } catch (error) {
        results[index] = {keyIndex: index, elapsedMs: performance.now() - started, exact: false,
          errorName: error instanceof Error ? error.name : "unknown"};
      } finally { inFlight--; }
    }
  };
  await Promise.all(Array.from({length: Math.min(CONCURRENCY, keyCount)}, worker));
  const exact = results.filter(sample => sample.exact);
  return {keyCount, partitionCount, bucketCount: partitionCount, issued: keyCount, completed: exact.length,
    failed: keyCount - exact.length, exactAnswers: exact.length, offeredConcurrency: Math.min(CONCURRENCY, keyCount),
    observedMaxInFlight, callerLatency: latency(results.map(sample => sample.elapsedMs)), samples: results};
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST" || request.headers.has("origin") ||
        JSON.stringify(env.LAYOUTS) !== JSON.stringify([
          {keyCount: 128, partitionCounts: [8, 16, 32, 64, 128]},
          {keyCount: 1024, partitionCounts: [8, 16, 32, 64, 128]},
        ])) return new Response("Not found", {status: 404});
    const path = new URL(request.url).pathname;
    if (path !== "/seed" && path !== "/read") return new Response("Not found", {status: 404});
    const operation = path === "/seed" ? "seed" : "read";
    const phases = [];
    for (const layout of env.LAYOUTS) {
      for (const partitionCount of layout.partitionCounts) {
        phases.push(await measure(layout.keyCount, partitionCount, operation, env));
      }
    }
    return Response.json({runId: env.RUN_ID, operation, architecture: "hash-partitioned append-only key-owner Durable Objects",
      workload: "unique independent keys, fixed max in-flight 128, no retries", phases});
  },
} satisfies ExportedHandler<Env>;
