import type PoneglyphService from "../src/index.js";
import type {LocalPointOwnerDO} from "./local-point-owner-do.js";

type Env = {PONEGLYPH: Service<PoneglyphService>; POINT_OWNERS: DurableObjectNamespace<LocalPointOwnerDO>;
  GRAPH_IDS: string[]; LOOKUP_KEYS: string[]; RUN_ID: string};
type Sample = {index: number; elapsedMs: number; exactAnswer: boolean; revision: number | null; cacheHits: number; errorName?: string};
const source = "control:local-point-owner-benchmark";
const field = "control:config:enabled";
const entityFor = (index: number) => `control:tenant:${index.toString().padStart(3, "0")}:feature-settings`;
const queryFor = (index: number) => `${field}(${JSON.stringify(entityFor(index))}, Enabled)`;
const factFor = (index: number) => ({source, entity: entityFor(index), field,
  value: {type: "text" as const, value: "true"}, retraction: false});
const latency = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
  return {count: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: sorted.at(-1) ?? null};
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST" || request.headers.has("origin")) return new Response("Not found", {status: 404});
    const path = new URL(request.url).pathname;
    if (env.GRAPH_IDS.length !== 128 || env.LOOKUP_KEYS.length !== 128 ||
        new Set(env.GRAPH_IDS).size !== 128 || new Set(env.LOOKUP_KEYS).size !== 128) {
      return new Response("Invalid point-owner experiment identities", {status: 500});
    }

    if (path === "/seed") {
      const started = performance.now();
      const graphWrites = await Promise.allSettled(env.GRAPH_IDS.map(async (graphId, index) => {
        using graph = await env.PONEGLYPH.getGraph({graphId});
        return graph.transact([factFor(index)], {clientRequestToken: `point-owner:${env.RUN_ID}:${index}`});
      }));
      const directWrites = await Promise.allSettled(env.LOOKUP_KEYS.map(async (key, index) => {
        const response = await env.POINT_OWNERS.getByName(key).fetch("https://point-owner.internal/write", {
          method: "POST", headers: {"content-type": "application/json"},
          body: JSON.stringify({key, value: "true", requestToken: `point-owner:${env.RUN_ID}:${index}`}),
        });
        if (!response.ok) throw new Error("Point-owner seed was not acknowledged");
        return response.json();
      }));
      return Response.json({runId: env.RUN_ID, count: env.GRAPH_IDS.length,
        graphWrites: {issued: graphWrites.length, acknowledged: graphWrites.filter(write => write.status === "fulfilled").length,
          failed: graphWrites.filter(write => write.status === "rejected").length},
        pointOwnerWrites: {issued: directWrites.length, acknowledged: directWrites.filter(write => write.status === "fulfilled").length,
          failed: directWrites.filter(write => write.status === "rejected").length},
        seedWallMs: performance.now() - started});
    }

    if (path !== "/read") return new Response("Not found", {status: 404});
    const run = async (architecture: "poneglyph-graph-per-key" | "append-only-point-owner", routing: "unique-keys" | "single-hot-key") => {
      const samples: Sample[] = Array(128);
      let cursor = 0, inFlight = 0, observedMaxInFlight = 0;
      const worker = async () => {
        while (cursor < 128) {
          const requester = cursor++;
          const index = routing === "single-hot-key" ? 0 : requester;
          inFlight++;
          observedMaxInFlight = Math.max(observedMaxInFlight, inFlight);
          const started = performance.now();
          try {
            if (architecture === "poneglyph-graph-per-key") {
              const result = await env.PONEGLYPH.query({graphId: env.GRAPH_IDS[index]!, query: queryFor(index)});
              const enabled = result.rows[0]?.["Enabled"];
              samples[requester] = {index: requester, elapsedMs: performance.now() - started,
                exactAnswer: result.rows.length === 1 && enabled?.type === "string" && enabled.value === "true" && result.snapshotSeq === 1,
                revision: result.snapshotSeq, cacheHits: result.metrics.cacheHits ?? 0};
            } else {
              const key = env.LOOKUP_KEYS[index]!;
              const response = await env.POINT_OWNERS.getByName(key).fetch("https://point-owner.internal/read", {
                method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({key}),
              });
              const raw: unknown = await response.json();
              if (!response.ok || typeof raw !== "object" || raw === null || Array.isArray(raw)) {
                throw new Error("Point-owner lookup failed");
              }
              const answer = raw as Record<string, unknown>;
              samples[requester] = {index: requester, elapsedMs: performance.now() - started,
                exactAnswer: Object.keys(answer).length === 3 && answer["key"] === key && answer["revision"] === 1 && answer["value"] === "true",
                revision: typeof answer["revision"] === "number" ? answer["revision"] : null, cacheHits: 0};
            }
          } catch (error) {
            samples[requester] = {index: requester, elapsedMs: performance.now() - started, exactAnswer: false,
              revision: null, cacheHits: 0, errorName: error instanceof Error ? error.name : "unknown"};
          } finally { inFlight--; }
        }
      };
      await Promise.all(Array.from({length: 128}, worker));
      const exact = samples.filter(sample => sample.exactAnswer);
      return {architecture, routing, issued: samples.length, completed: exact.length, failed: samples.length - exact.length,
        exactAnswers: exact.length, offeredConcurrency: 128, observedMaxInFlight,
        cacheHits: samples.reduce((sum, sample) => sum + sample.cacheHits, 0),
        callerLatency: latency(samples.map(sample => sample.elapsedMs)), samples};
    };
    const phases = [];
    for (const routing of ["unique-keys", "single-hot-key"] as const) {
      phases.push(await run("poneglyph-graph-per-key", routing));
      phases.push(await run("append-only-point-owner", routing));
    }
    return Response.json({runId: env.RUN_ID,
      workload: "128 independent control-plane keys, unique-key and single-hot-key reads, 128 concurrent calls, no application retries",
      phases});
  },
} satisfies ExportedHandler<Env>;
