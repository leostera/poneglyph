import { parseFactBatch } from "@leostera/poneglyph";
import type { InferEnv } from "cf/config";
import type { operatorBindings } from "../cloudflare.config.ts";
import { GRAPH_HEADER, selectGraph } from "./registry.js";
type Env = InferEnv<{ env: typeof operatorBindings }>;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
async function boundedJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > 900_000) { await reader.cancel(); throw new Error("Body exceeds 900000 bytes"); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
// Dev-only entrypoint. No domain, Origin access or arbitrary graph selection.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || request.headers.has("origin")) return json({ error: "Forbidden" }, 403);
    if (url.pathname !== "/load" || request.method !== "POST") return json({ error: "Not found" }, 404);
    if (request.headers.get("content-type") !== "application/json") return json({ error: "JSON required" }, 415);
    const scope = selectGraph(request.headers.get(GRAPH_HEADER));
    if (!scope) return json({ error: "Unknown benchmark graph" }, 403);
    let raw: unknown;
    try { raw = await boundedJson(request); } catch { return json({ error: "Invalid or oversized JSON" }, 400); }
    const parsed = parseFactBatch(raw);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    if (parsed.value.facts.length > 100) return json({ error: "At most 100 facts per batch" }, 400);
    // This operator only appends this benchmark's facts. Parsing/authorization
    // finishes before capability acquisition or transaction side effects.
    const source = `memorybench:${scope.datasetHash}:${scope.variant}`;
    if (!parsed.value.txId.startsWith(`memorybench:${scope.graphId}:`) || parsed.value.facts.some(fact => fact.source !== source || fact.retraction)) return json({ error: "Invalid benchmark batch scope" }, 400);
    try {
      using graph = await env.PONEGLYPH.getGraph({ graphId: scope.graphId });
      const receipt = await graph.transactApprovedBatch(parsed.value.facts, { txId: parsed.value.txId });
      return json({ ...receipt, graphId: scope.graphId, facts: parsed.value.facts.length });
    } catch (error) {
      // Only an explicit service 4xx supplies a definitive storage outcome.
      const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : undefined;
      return json({ error: "Benchmark batch not acknowledged", status, delivery: status !== undefined && status >= 400 && status < 500 ? "rejected" : "unknown" }, 502);
    }
  },
} satisfies ExportedHandler<Env>;
