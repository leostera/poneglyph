import type {LocalPointBucketDO} from "./local-point-bucket-do.js";

type Env = {BUCKETS: DurableObjectNamespace<LocalPointBucketDO>; RUN_ID: string; PARTITION_COUNTS: number[]};
type Sample = {keyIndex: number; elapsedMs: number; exact: boolean; errorName?: string};
const KEY_COUNT = 1_024;
const PARTITION_COUNTS = [8, 16, 32, 64, 128] as const;
const LOAD_LEVELS = [1_024, 512] as const;
const keyFor = (partitionCount: number, index: number) =>
  `control:bucket-load:${partitionCount}:${KEY_COUNT}:key:${index.toString().padStart(4, "0")}`;
const bucketName = (partitionCount: number, index: number) =>
  `control-bucket-load-${KEY_COUNT}-${partitionCount}-${index % partitionCount}`;
const valueFor = (index: number) => `value-${index}`;
const latency = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
  return {count: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: sorted.at(-1) ?? null};
};
async function measure(partitionCount: number, operation: "seed" | "read", concurrency: number, env: Env) {
  const results: Sample[] = Array(KEY_COUNT);
  let cursor = 0, inFlight = 0, observedMaxInFlight = 0;
  const worker = async () => {
    while (cursor < KEY_COUNT) {
      const index = cursor++;
      inFlight++;
      observedMaxInFlight = Math.max(observedMaxInFlight, inFlight);
      const started = performance.now();
      try {
        const key = keyFor(partitionCount, index), bucket = env.BUCKETS.getByName(bucketName(partitionCount, index));
        const response = operation === "seed"
          ? await bucket.fetch("https://point-bucket.internal/write", {method: "POST", headers: {"content-type": "application/json"},
              body: JSON.stringify({key, value: valueFor(index), requestToken: `bucket-load:${env.RUN_ID}:${partitionCount}:${index}`})})
          : await bucket.fetch("https://point-bucket.internal/read", {method: "POST", headers: {"content-type": "application/json"},
              body: JSON.stringify({key})});
        const raw: unknown = await response.json();
        const exact = response.ok && typeof raw === "object" && raw !== null && !Array.isArray(raw) &&
          Object.keys(raw).length === (operation === "seed" ? 2 : 3) && (raw as Record<string, unknown>)["revision"] === 1 &&
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
  await Promise.all(Array.from({length: Math.min(concurrency, KEY_COUNT)}, worker));
  const exact = results.filter(sample => sample.exact);
  return {keyCount: KEY_COUNT, partitionCount, bucketCount: partitionCount,
    issued: KEY_COUNT, completed: exact.length, failed: KEY_COUNT - exact.length,
    offeredConcurrency: Math.min(concurrency, KEY_COUNT), observedMaxInFlight,
    callerLatency: latency(results.map(sample => sample.elapsedMs)), samples: results};
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST" || request.headers.has("origin") ||
        JSON.stringify(env.PARTITION_COUNTS) !== JSON.stringify(PARTITION_COUNTS)) return new Response("Not found", {status: 404});
    const path = new URL(request.url).pathname;
    if (path === "/seed") {
      const phases = [];
      for (const partitionCount of PARTITION_COUNTS) phases.push(await measure(partitionCount, "seed", 128, env));
      return Response.json({runId: env.RUN_ID, phases});
    }
    if (path !== "/read") return new Response("Not found", {status: 404});
    const phases = [];
    for (const partitionCount of PARTITION_COUNTS) {
      for (const concurrency of LOAD_LEVELS) phases.push(await measure(partitionCount, "read", concurrency, env));
    }
    return Response.json({runId: env.RUN_ID, workload: "1,024 unique keys; partition-count sweep at concurrency 1,024 then 512; no retries", phases});
  },
} satisfies ExportedHandler<Env>;
