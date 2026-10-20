import type PoneglyphService from "../src/index.js";

type Partition = {count: number; graphIds: string[]};
type Env = {PONEGLYPH: Service<PoneglyphService>; PARTITIONS: Partition[]; RUN_ID: string};
type ServerTiming = Readonly<{executionMs: number; snapshotMs: number; evaluationMs: number; releaseMs: number}>;
type Result = {tenant: number; elapsedMs: number; exactAnswer: boolean; snapshotSeq: number | null;
  cacheHits: number; serverTiming?: ServerTiming; errorName?: string};
const source = "control:local-partition-count-profile";
const queryRounds = [0, 1, 2, 3] as const;
const partitionCounts = [1, 2, 4, 8, 16, 32, 64, 128] as const;
const tenantCount = 128;
const entityFor = (tenant: number) => `control:tenant:${tenant.toString().padStart(3, "0")}:feature-settings`;
const fieldFor = (round: number) => `control:config:enabled:round-${round}`;
const queryFor = (tenant: number, round: number) => `${fieldFor(round)}(${JSON.stringify(entityFor(tenant))}, Enabled)`;
const factsFor = (tenant: number) => queryRounds.map(round => ({source, entity: entityFor(tenant), field: fieldFor(round),
  value: {type: "text" as const, value: "true"}, retraction: false}));
const latency = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
  return {count: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: sorted.at(-1) ?? null};
};
const serverTiming = (samples: Result[]) => Object.fromEntries(
  (["executionMs", "snapshotMs", "evaluationMs", "releaseMs"] as const).map(field => [field,
    latency(samples.flatMap(sample => sample.serverTiming === undefined ? [] : [sample.serverTiming[field]]))]),
);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST" || request.headers.has("origin")) return new Response("Not found", {status: 404});
    const path = new URL(request.url).pathname;
    if (env.PARTITIONS.length !== partitionCounts.length || env.PARTITIONS.some((partition, index) =>
      partition.count !== partitionCounts[index] || partition.graphIds.length !== partition.count)) {
      return new Response("Invalid partition experiment plan", {status: 500});
    }

    if (path === "/seed") {
      const started = performance.now();
      const seeded = [];
      for (const partition of env.PARTITIONS) {
        const batches = Array.from({length: partition.count}, () => [] as ReturnType<typeof factsFor>);
        for (let tenant = 0; tenant < tenantCount; tenant++) batches[tenant % partition.count]!.push(...factsFor(tenant));
        const writes = await Promise.allSettled(partition.graphIds.map(async (graphId, index) => {
          using graph = await env.PONEGLYPH.getGraph({graphId});
          return graph.transact(batches[index]!, {clientRequestToken: `partition-counts:${env.RUN_ID}:${partition.count}:${index}`});
        }));
        const failedPartitions = writes.map((result, index) => result.status === "rejected" ? index : -1).filter(index => index >= 0);
        seeded.push({partitionCount: partition.count, graphTransactions: writes.length,
          acknowledged: writes.length - failedPartitions.length, failedPartitions});
      }
      return Response.json({runId: env.RUN_ID, tenantCount, partitionCounts: seeded,
        seedWallMs: performance.now() - started});
    }

    if (path !== "/read") return new Response("Not found", {status: 404});
    const phases = [];
    for (const [layoutIndex, partition] of env.PARTITIONS.entries()) {
      const samples: Result[] = Array(tenantCount);
      let cursor = 0, inFlight = 0, observedMaxInFlight = 0;
      const worker = async () => {
        while (cursor < tenantCount) {
          const tenant = cursor++;
          inFlight++;
          observedMaxInFlight = Math.max(observedMaxInFlight, inFlight);
          const started = performance.now();
          try {
            const result = await env.PONEGLYPH.query({graphId: partition.graphIds[tenant % partition.count]!,
              query: queryFor(tenant, queryRounds[layoutIndex % queryRounds.length]!)});
            const enabled = result.rows[0]?.["Enabled"];
            samples[tenant] = {tenant, elapsedMs: performance.now() - started,
              exactAnswer: result.rows.length === 1 && enabled?.type === "string" && enabled.value === "true" && result.snapshotSeq === 1,
              snapshotSeq: result.snapshotSeq, cacheHits: result.metrics.cacheHits ?? 0, serverTiming: result.metrics.timing};
          } catch (error) {
            samples[tenant] = {tenant, elapsedMs: performance.now() - started, exactAnswer: false,
              snapshotSeq: null, cacheHits: 0, errorName: error instanceof Error ? error.name : "unknown"};
          } finally { inFlight--; }
        }
      };
      await Promise.all(Array.from({length: tenantCount}, worker));
      const exact = samples.filter(sample => sample.exactAnswer);
      phases.push({partitionCount: partition.count, graphCount: partition.graphIds.length,
        offered: tenantCount, completed: exact.length, failed: tenantCount - exact.length,
        exactAnswers: exact.length, offeredConcurrency: tenantCount, observedMaxInFlight,
        cacheHits: samples.reduce((sum, sample) => sum + sample.cacheHits, 0),
        callerLatency: latency(samples.map(sample => sample.elapsedMs)), serviceTiming: serverTiming(samples), samples});
    }
    return Response.json({runId: env.RUN_ID,
      workload: "128 unique cold pointed lookups per partition layout; 128 concurrent requests; no retries",
      phases});
  },
} satisfies ExportedHandler<Env>;
