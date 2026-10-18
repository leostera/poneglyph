import type {InferEnv} from "cf/config";
import type {writeBindings} from "./cloudflare.config.ts";
import {isRecord, coordinatorObjectName, ledgerCoordinatorName, LEDGER_BUCKETS,
  readJsonBody, sha256Hex, readFailureReason} from "@leostera/poneglyph/storage-protocol";
import {classify, payload, phases, settings} from "./model.js";

type Env = InferEnv<{env: typeof writeBindings}>;
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.has("origin")) return new Response("Forbidden", {status: 403});
    const scope = settings(env.RUN_ID, env.CASE, env.COUNT), path = new URL(request.url).pathname;
    const answer = (body: object, status = 200) => Response.json({runId: scope.runId, case: scope.kind, ...body}, {status});
    if (request.method === "GET" && path === "/health") return answer({graphId: scope.graphId, count: scope.count});
    if (request.method !== "POST") return answer({kind: "not-found"}, 404);
    if (env.AUDIT_ONLY && path !== "/audit") return answer({kind: "audit-only"}, 403);
    try {
      if (path === "/audit" || path === "/preflight") {
        const totals = Object.fromEntries(phases.map(phase => [phase, 0]));
        let tokens = 0;
        for (const bucket of LEDGER_BUCKETS) {
          const response = await env.GRAPH_LEDGERS.getByName(ledgerCoordinatorName(scope.graphId, bucket)).fetch(
            "https://ledger.internal/_ledger-audit", {method: "POST"});
          const parsed = await readJsonBody(response, 16_384);
          if (!response.ok || !parsed.ok || !isRecord(parsed.value)) throw new Error("Invalid audit response");
          const raw = parsed.value;
          if (!Array.isArray(raw["context"]) || raw["context"].length > 1 || raw["context"].some(row => !isRecord(row) || row["graph_id"] !== scope.graphId || row["bucket"] !== bucket) ||
              !Array.isArray(raw["phases"]) || !Array.isArray(raw["requestTokens"]) || raw["requestTokens"].length !== 1) throw new Error("Invalid audit scope");
          for (const row of raw["phases"]) {
            if (!isRecord(row) || typeof row["phase"] !== "string" || !Object.hasOwn(totals, row["phase"]) || typeof row["count"] !== "number" || !Number.isSafeInteger(row["count"]) || row["count"] < 0) throw new Error("Invalid audit phase");
            totals[row["phase"]]! += row["count"];
          }
          const token = raw["requestTokens"][0];
          if (!isRecord(token) || typeof token["count"] !== "number" || !Number.isSafeInteger(token["count"]) || token["count"] < 0) throw new Error("Invalid audit token count");
          tokens += token["count"];
        }
        if (path === "/preflight") {
          if (tokens !== 0 || Object.values(totals).some(count => count !== 0)) throw new Error("Benchmark graph is not empty");
          const response = await env.GRAPH_FACADES.getByName(coordinatorObjectName(scope.graphId)).fetch(
            `https://graph.internal/v1/graphs/${scope.graphId}/query`, {method: "POST", body: JSON.stringify({query: 'control:policy:allowed-action("control:write-bench:settings", "action-0")'})});
          const parsed = await readJsonBody(response, 32_768);
          if (!response.ok || !parsed.ok || !isRecord(parsed.value) || !Array.isArray(parsed.value["rows"]) || parsed.value["rows"].length !== 0) throw new Error("Benchmark graph is not initially readable and empty");
        }
        return answer({kind: "audit", at: new Date().toISOString(), tokens, phases: totals});
      }
      if (path !== "/write" && path !== "/verify") return answer({kind: "not-found"}, 404);
      const parsed = await readJsonBody(request, 16_384);
      if (!parsed.ok) return answer({kind: "invalid-payload"}, 400);
      const input = payload(scope, parsed.value), payloadSha256 = await sha256Hex(JSON.stringify(input.facts));
      if (path === "/verify") {
        const first = input.facts[0];
        if (!isRecord(first) || typeof first["entity"] !== "string") throw new Error("Invalid verification entity");
        const query = scope.kind === "hot" ? `control:policy:allowed-action("control:write-bench:settings", "action-${input.index}")` :
          `wiki:page:title(${JSON.stringify(first["entity"])}, Title)`;
        const response = await env.GRAPH_FACADES.getByName(coordinatorObjectName(scope.graphId)).fetch(
          `https://graph.internal/v1/graphs/${scope.graphId}/query`, {method: "POST", body: JSON.stringify({query})});
        const result = await readJsonBody(response, 32_768);
        if (!response.ok || !result.ok || !isRecord(result.value) || !Array.isArray(result.value["rows"])) throw new Error("Verification read is unavailable");
        return answer({kind: "verification", index: input.index, rows: result.value["rows"]});
      }
      const started = performance.now();
      try {
        // One public transaction route per independent invocation. No retries,
        // internal transaction IDs, active-head opt-in, or corpus-graph writes.
        const response = await env.GRAPH_FACADES.getByName(coordinatorObjectName(scope.graphId)).fetch(
          `https://graph.internal/v1/graphs/${scope.graphId}/transactions`, {method: "POST",
            body: JSON.stringify({clientRequestToken: input.clientRequestToken, facts: input.facts})});
        const result = await readJsonBody(response, 16_384), hostedMs = performance.now() - started;
        if (!result.ok || !isRecord(result.value)) return answer({kind: "protocol", index: input.index, payloadSha256, hostedMs,
          backendStatus: response.status, responseKind: response.headers.get("content-type")?.includes("json") ? "json" : "non-json"}, 502);
        if (response.ok) {
          const txId = result.value["txId"];
          if (typeof txId !== "string" || !/^poneglyph:tx:token:[0-9a-f]:[0-9a-f-]{36}$/.test(txId)) return answer({kind: "protocol", index: input.index, payloadSha256, hostedMs}, 502);
          return answer({kind: "acknowledged", index: input.index, payloadSha256, hostedMs, txId, backendStatus: response.status});
        }
        return answer({kind: classify(response.status, result.value), index: input.index, payloadSha256, hostedMs, backendStatus: response.status}, 502);
      } catch (error) {
        return answer({kind: readFailureReason(error), index: input.index, payloadSha256, hostedMs: performance.now() - started}, 502);
      }
    } catch { return answer({kind: "operator-failure"}, 502); }
  },
} satisfies ExportedHandler<Env>;
