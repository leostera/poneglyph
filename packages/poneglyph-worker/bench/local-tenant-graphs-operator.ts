import type PoneglyphService from "../src/index.js";

type Env = {PONEGLYPH: Service<PoneglyphService>; GRAPH_IDS: string[]; RUN_ID: string};
const sharedGraph = "control-plane-shared";
const source = "control:local-tenant-graph-scaling";
const queryRounds = [0, 1, 2, 3] as const;
const loadLevels = [16, 32, 64, 128] as const;
const entityFor = (tenant: number) => `control:tenant:${tenant.toString().padStart(3, "0")}:feature-settings`;
const fieldFor = (round: number) => `control:config:enabled:round-${round}`;
const queryFor = (tenant: number, round: number) => `${fieldFor(round)}(${JSON.stringify(entityFor(tenant))}, Enabled)`;
const factsFor = (tenant: number) => queryRounds.map(round => ({source, entity: entityFor(tenant),
  field: fieldFor(round), value: {type: "text" as const, value: "true"}, retraction: false}));
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
    if (tenantCount !== 128 || new Set(env.GRAPH_IDS).size !== tenantCount) return new Response("Invalid experiment graph set", {status: 500});

    if (path === "/seed") {
      const started = performance.now();
      const perTenant = await Promise.allSettled(env.GRAPH_IDS.map(async (graphId, tenant) => {
        using graph = await env.PONEGLYPH.getGraph({graphId});
        return graph.transact(factsFor(tenant), {clientRequestToken: `tenant-graphs:${env.RUN_ID}:${tenant}`});
      }));
      using shared = await env.PONEGLYPH.getGraph({graphId: sharedGraph});
      const sharedReceipt = await shared.transact(env.GRAPH_IDS.flatMap((_, tenant) => factsFor(tenant)),
        {clientRequestToken: `tenant-graphs:${env.RUN_ID}:shared`});
      const failedTenantWrites = perTenant.map((result, tenant) => result.status === "rejected" ? tenant : -1).filter(tenant => tenant >= 0);
      return Response.json({runId: env.RUN_ID, graphCount: tenantCount, sharedWriteAcknowledged: !!sharedReceipt.txId,
        independentGraphWrites: perTenant.length, completedIndependentWrites: perTenant.length - failedTenantWrites.length,
        failedTenantWrites, seedWallMs: performance.now() - started});
    }

    if (path !== "/read") return new Response("Not found", {status: 404});
    const run = async (mode: "one-graph" | "tenant-graphs", concurrency: number, queryRound: number) => {
      const samples: Array<{tenant: number; elapsedMs: number; exactAnswer: boolean; snapshotSeq: number | null;
        cacheHits: number; shardRequests: number; errorName?: string}> = Array(tenantCount);
      let cursor = 0, inFlight = 0, observedMaxInFlight = 0;
      const worker = async () => {
        while (cursor < tenantCount) {
          const tenant = cursor++;
          inFlight++;
          observedMaxInFlight = Math.max(observedMaxInFlight, inFlight);
          const started = performance.now();
          try {
            const result = await env.PONEGLYPH.query({graphId: mode === "one-graph" ? sharedGraph : env.GRAPH_IDS[tenant]!,
              query: queryFor(tenant, queryRound)});
            const enabled = result.rows[0]?.["Enabled"];
            const exactAnswer = result.rows.length === 1 && enabled?.type === "string" && enabled.value === "true" && result.snapshotSeq >= 1;
            samples[tenant] = {tenant, elapsedMs: performance.now() - started, exactAnswer,
              snapshotSeq: result.snapshotSeq, cacheHits: result.metrics.cacheHits ?? 0, shardRequests: result.metrics.shardRequests};
          } catch (error) {
            samples[tenant] = {tenant, elapsedMs: performance.now() - started, exactAnswer: false,
              snapshotSeq: null, cacheHits: 0, shardRequests: 0, errorName: error instanceof Error ? error.name : "unknown"};
          } finally { inFlight--; }
        }
      };
      await Promise.all(Array.from({length: concurrency}, worker));
      const completed = samples.filter(sample => sample?.exactAnswer);
      return {mode, queryRound, offered: tenantCount, completed: completed.length, failed: tenantCount - completed.length,
        callerLatency: latency(samples.map(sample => sample.elapsedMs)), exactAnswers: completed.length,
        offeredConcurrency: concurrency, observedMaxInFlight, cacheHits: completed.reduce((sum, sample) => sum + sample.cacheHits, 0), samples};
    };
    const phases = [];
    for (const concurrency of loadLevels) {
      for (const mode of ["one-graph", "tenant-graphs"] as const) {
        const queryRound = loadLevels.indexOf(concurrency);
        phases.push(await run(mode, concurrency, queryRound));
      }
    }
    return Response.json({runId: env.RUN_ID, query: "unique cold pointed lookup per tenant; increasing offered concurrency; no application retries", phases});
  },
} satisfies ExportedHandler<Env>;
