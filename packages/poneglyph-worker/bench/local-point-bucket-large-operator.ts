import type {LocalPointBucketDO} from "./local-point-bucket-do.js";

type Env = {BUCKETS: DurableObjectNamespace<LocalPointBucketDO>; RUN_ID: string};
type Sample = {keyIndex: number; elapsedMs: number; exact: boolean; errorName?: string};
const KEY_COUNT = 16_384, PARTITION_COUNT = 32;
const READ_CONCURRENCIES = [512, 1_024, 256] as const;
const keyFor = (index: number) => `control:bucket-large:${KEY_COUNT}:key:${index.toString().padStart(5, "0")}`;
const bucketName = (index: number) => `control-bucket-large-${KEY_COUNT}-${PARTITION_COUNT}-${index % PARTITION_COUNT}`;
const valueFor = (index: number) => `value-${index}`;
const latency = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
  return {count: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: sorted.at(-1) ?? null};
};
async function measure(operation: "seed" | "read", concurrency: number, env: Env) {
  const results: Sample[] = Array(KEY_COUNT);
  let cursor = 0, inFlight = 0, observedMaxInFlight = 0;
  const worker = async () => {
    while (cursor < KEY_COUNT) {
      const index = cursor++;
      inFlight++;
      observedMaxInFlight = Math.max(observedMaxInFlight, inFlight);
      const started = performance.now();
      try {
        const key = keyFor(index), bucket = env.BUCKETS.getByName(bucketName(index));
        const response = operation === "seed"
          ? await bucket.fetch("https://point-bucket.internal/write", {method: "POST", headers: {"content-type": "application/json"},
              body: JSON.stringify({key, value: valueFor(index), requestToken: `bucket-large:${env.RUN_ID}:${index}`})})
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
  return {issued: KEY_COUNT, completed: exact.length, failed: KEY_COUNT - exact.length,
    offeredConcurrency: concurrency, observedMaxInFlight,
    callerLatency: latency(results.map(sample => sample.elapsedMs)), samples: results};
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST" || request.headers.has("origin")) return new Response("Not found", {status: 404});
    const path = new URL(request.url).pathname;
    if (path === "/seed") return Response.json({runId: env.RUN_ID, keyCount: KEY_COUNT,
      bucketCount: PARTITION_COUNT, write: await measure("seed", 128, env)});
    if (path === "/read") {
      const phases = [];
      for (const concurrency of READ_CONCURRENCIES) phases.push(await measure("read", concurrency, env));
      return Response.json({runId: env.RUN_ID, keyCount: KEY_COUNT, bucketCount: PARTITION_COUNT, phases});
    }
    return new Response("Not found", {status: 404});
  },
} satisfies ExportedHandler<Env>;
