import type PoneglyphService from "../src/index.js";

type Env = {PONEGLYPH: Service<PoneglyphService>; GRAPH_IDS: string[]; RUN_ID: string};
const sharedGraph = "control-plane-shared";
const source = "control:local-tenant-graph-scaling";
const entityFor = (tenant: number) => `control:tenant:${tenant.toString().padStart(3, "0")}:feature-settings`;
const field = "control:config:enabled";
const queryFor = (tenant: number) => `${field}(${JSON.stringify(entityFor(tenant))}, Enabled)`;
const factFor = (tenant: number) => ({source, entity: entityFor(tenant), field,
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
    const tenantCount = env.GRAPH_IDS.length;
    if (tenantCount !== 100 || new Set(env.GRAPH_IDS).size !== tenantCount) return new Response("Invalid experiment graph set", {status: 500});

    if (path === "/seed") {
      const started = performance.now();
      const perTenant = await Promise.allSettled(env.GRAPH_IDS.map(async (graphId, tenant) => {
        using graph = await env.PONEGLYPH.getGraph({graphId});
        return graph.transact([factFor(tenant)], {clientRequestToken: `tenant-graphs:${env.RUN_ID}:${tenant}`});
      }));
      using shared = await env.PONEGLYPH.getGraph({graphId: sharedGraph});
      const sharedReceipt = await shared.transact(env.GRAPH_IDS.map((_, tenant) => factFor(tenant)),
        {clientRequestToken: `tenant-graphs:${env.RUN_ID}:shared`});
      const failedTenantWrites = perTenant.map((result, tenant) => result.status === "rejected" ? tenant : -1).filter(tenant => tenant >= 0);
      return Response.json({runId: env.RUN_ID, graphCount: tenantCount, sharedWriteAcknowledged: !!sharedReceipt.txId,
        independentGraphWrites: perTenant.length, completedIndependentWrites: perTenant.length - failedTenantWrites.length,
        failedTenantWrites, seedWallMs: performance.now() - started});
    }

    if (path !== "/read") return new Response("Not found", {status: 404});
    const run = async (mode: "one-graph" | "tenant-graphs") => {
      const samples = await Promise.all(env.GRAPH_IDS.map(async (graphId, tenant) => {
        const started = performance.now();
        try {
          const result = await env.PONEGLYPH.query({graphId: mode === "one-graph" ? sharedGraph : graphId,
            query: queryFor(tenant)});
          const elapsedMs = performance.now() - started;
          const enabled = result.rows[0]?.["Enabled"];
          const exactAnswer = result.rows.length === 1 && enabled?.type === "string" && enabled.value === "true" && result.snapshotSeq >= 1;
          return {tenant, elapsedMs, exactAnswer, snapshotSeq: result.snapshotSeq,
            cacheHits: result.metrics.cacheHits ?? 0, shardRequests: result.metrics.shardRequests};
        } catch (error) {
          return {tenant, elapsedMs: performance.now() - started, exactAnswer: false, snapshotSeq: null,
            cacheHits: 0, shardRequests: 0, errorName: error instanceof Error ? error.name : "unknown"};
        }
      }));
      const good = samples.filter(sample => sample.exactAnswer);
      return {mode, offered: samples.length, completed: good.length, failed: samples.length - good.length,
        callerLatency: latency(samples.map(sample => sample.elapsedMs)), exactAnswers: good.length,
        offeredConcurrency: samples.length, cacheHits: good.reduce((sum, sample) => sum + (sample.cacheHits ?? 0), 0), samples};
    };
    const shared = await run("one-graph");
    const tenantGraphs = await run("tenant-graphs");
    return Response.json({runId: env.RUN_ID, query: "one cold pointed lookup per tenant; 100 concurrent requests per phase; no application retries",
      phases: [shared, tenantGraphs]});
  },
} satisfies ExportedHandler<Env>;
