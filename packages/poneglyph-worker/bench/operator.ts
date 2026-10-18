import type { InferEnv } from "cf/config";
import type { readBindings } from "./cloudflare.config.ts";
import type { ProbeResult } from "./plan.js";

type Env = InferEnv<{env: typeof readBindings}>;
const tenant = "control:tenant:d9d839ba-4c07-41dc-a5bd-77ccc5763413";
const feature = `${tenant}:feature-settings`, credential = `${tenant}:credential-settings`;
const point = `control:config:enabled(${JSON.stringify(feature)}, Enabled)`;
const combined = [
  `control:config:tenant(${JSON.stringify(feature)}, Tenant)`, point,
  `control:credential:tenant(${JSON.stringify(credential)}, Tenant)`,
  `control:credential:token-version(${JSON.stringify(credential)}, TokenVersion)`,
  `control:credential:status(${JSON.stringify(credential)}, Status)`,
].join(", ");

function response(runId: string, result: ProbeResult): Response {
  return Response.json({runId, ...result}, {status: result.kind === "complete" ? 200 : 502});
}

/** Ephemeral, authenticated remote preview only. Never a deployment target. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.headers.has("origin")) return new Response("Forbidden", {status: 403});
    if (path === "/health" && request.method === "GET") return Response.json({runId: env.RUN_ID, readOnly: true});
    if (request.method !== "POST" || path !== "/point" && path !== "/combined") return new Response("Not found", {status: 404});
    const started = performance.now();
    try {
      // One native service-binding RPC in each independent HTTP invocation.
      const result = await env.PONEGLYPH.query({graphId: "control-plane-validation", query: path === "/point" ? point : combined});
      const row = result.rows[0];
      const expected = result.snapshotSeq === 1 && result.rows.length === 1 && row?.Enabled?.type === "string" && row.Enabled.value === "false" &&
        (path === "/point" || row?.Tenant?.value === tenant && row?.Status?.value === "active" &&
          row?.TokenVersion?.value === "fake-token-test-only-v0-d9d839ba-4c07-41dc-a5bd-77ccc5763413");
      if (!expected) return response(env.RUN_ID, {kind: "unexpected-answer", hostedMs: performance.now() - started});
      const {timing, cacheHits, treeReadLeaseAcquisitions} = result.metrics;
      if (timing === undefined || typeof cacheHits !== "number" || typeof treeReadLeaseAcquisitions !== "number") {
        return response(env.RUN_ID, {kind: "invalid-metrics", hostedMs: performance.now() - started});
      }
      return response(env.RUN_ID, {kind: "complete", metrics: {
        snapshotSeq: result.snapshotSeq, hostedMs: performance.now() - started, serviceMs: timing.executionMs,
        snapshotMs: timing.snapshotMs, evaluationMs: timing.evaluationMs, releaseMs: timing.releaseMs,
        cacheHits, leases: treeReadLeaseAcquisitions,
      }});
    } catch {
      return response(env.RUN_ID, {kind: "unavailable", hostedMs: performance.now() - started});
    }
  },
} satisfies ExportedHandler<Env>;
