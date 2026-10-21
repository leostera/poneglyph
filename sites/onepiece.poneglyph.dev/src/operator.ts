import type { FactInput } from "@leostera/poneglyph";
import type { InferEnv } from "cf/config";
import type { seedBindings } from "../cloudflare.config.ts";
import { GRAPH_ID } from "./runtime.js";

type OperatorEnv = InferEnv<{ env: typeof seedBindings }>;

const MAX_BODY_BYTES = 900_000;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

// Local-only operator entrypoint for scripts/load-corpus.ts. Never deployed:
// it listens on loopback under `cf dev --mode seed`, and its remote service
// binding is authenticated by the operator's own Cloudflare session. The
// loader supplies pinned, hash-verified batches with stable transaction IDs.
export default {
  async fetch(request: Request, env: OperatorEnv): Promise<Response> {
    const url = new URL(request.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || request.headers.has("origin")) return new Response("Forbidden", { status: 403 });
    if (!["/load", "/query"].includes(url.pathname) || request.method !== "POST" || request.headers.get("content-type") !== "application/json") return new Response("Not found", { status: 404 });
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: "body too large" }, 413);
    const body = JSON.parse(text) as { txId?: unknown; facts?: unknown; query?: unknown };
    using graph = await env.PONEGLYPH.getGraph({ graphId: GRAPH_ID });
    if (url.pathname === "/query") {
      if (typeof body.query !== "string") return json({ error: "query required" }, 400);
      const started = performance.now();
      try {
        const result = await graph.query(body.query);
        return json({ ...result, elapsedMs: Math.round(performance.now() - started) });
      } catch (error) {
        return json({ error: safeError(error) }, 502);
      }
    }
    if (typeof body.txId !== "string" || !Array.isArray(body.facts)) return json({ error: "txId and facts required" }, 400);
    try {
      const receipt = await graph.transactApprovedBatch(body.facts as FactInput[], { txId: body.txId });
      return json({ ...receipt, graphId: GRAPH_ID, facts: body.facts.length });
    } catch (error) {
      // Status is preserved for the loader: 4xx is a definitive storage answer
      // (422 = durably aborted); anything else leaves delivery unknown.
      const failure = safeError(error);
      return json({ error: failure, delivery: failure.status !== undefined && failure.status < 500 ? "rejected" : "unknown" }, 502);
    }
  },
} satisfies ExportedHandler<OperatorEnv>;

function safeError(error: unknown): { name?: string; status?: number; message?: string } {
  if (typeof error !== "object" || error === null) return {};
  const record = error as Record<string, unknown>;
  return {
    ...(typeof record["name"] === "string" ? { name: record["name"] } : {}),
    ...(typeof record["status"] === "number" ? { status: record["status"] } : {}),
    ...(typeof record["message"] === "string" ? { message: record["message"].slice(0, 300) } : {}),
  };
}
