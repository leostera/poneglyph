import { createDatabase } from "@leostera/poneglyph";
import type { InferEnv } from "cf/config";
import type { seedBindings } from "../cloudflare.config.ts";
import { GRAPH_ID } from "./runtime.js";
import { TEST_FACTS, TEST_TX_ID } from "./test-facts.js";

type OperatorEnv = InferEnv<{ env: typeof seedBindings }>;

// Local-only operator entrypoint. Never included in the public Worker. The
// remote service binding is authenticated by the operator's Cloudflare session;
// the private database gains no public hostname, write endpoint or MCP tool.
export default {
  async fetch(request: Request, env: OperatorEnv): Promise<Response> {
    const url = new URL(request.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || request.headers.has("origin")) return new Response("Forbidden", { status: 403 });
    if (!["/seed", "/verify"].includes(url.pathname) || request.method !== "POST" || request.headers.get("content-type") !== "application/json") return new Response("Not found", { status: 404 });
    const graph = createDatabase({ url: "https://database.internal", graphId: GRAPH_ID, fetch: (input, init) => env.PONEGLYPH.fetch(input, init) });
    if (url.pathname === "/verify") {
      // Three fixed SELECT-only checks through the authenticated binding, not
      // an alternate public MCP URL or caller-controlled query interface.
      const results = [];
      for (const source of [
        "wiki:page:title(Page, Title)",
        'wiki:page:title(Page, "Monkey D. Luffy"), wiki:page:link(Page, TargetTitle), wiki:page:title(TargetPage, TargetTitle)',
        'wiki:page:namespace("wiki:onepiece:page:Monkey%20D.%20Luffy", Namespace), wiki:page:text_bytes("wiki:onepiece:page:Monkey%20D.%20Luffy", Bytes)',
      ]) results.push({ source, result: await graph.query(source) });
      return Response.json({ graphId: GRAPH_ID, results });
    }
    // No caller-supplied facts, graph or backend. One fixed tiny transaction.
    const receipt = await graph.transact(TEST_FACTS, { txId: TEST_TX_ID });
    return Response.json({ ...receipt, graphId: GRAPH_ID, facts: TEST_FACTS.length, dataset: "synthetic-smoke-fixture; not wiki corpus" });
  },
} satisfies ExportedHandler<OperatorEnv>;
