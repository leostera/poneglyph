import { createPoneglyphMcpHandler } from "@leostera/poneglyph-mcp";
import type { InferEnv } from "cf/config";
import type { playgroundBindings } from "../cloudflare.config.ts";
import { connectionPage } from "./page.js";
import { createGraphReader } from "./reader.js";
import { DATASET, PUBLIC_HOST } from "./dataset.js";
import { admitMcpRequest } from "./rate-limit.js";

type PlaygroundEnv = InferEnv<{ env: typeof playgroundBindings }>;
const ALLOWED_HOSTS = [PUBLIC_HOST, "localhost", "127.0.0.1", "[::1]"];

export default {
  async fetch(request: Request, env: PlaygroundEnv): Promise<Response> {
    const url = new URL(request.url);
    if (!ALLOWED_HOSTS.includes(url.hostname)) return new Response("Invalid host", { status: 403 });
    if (url.pathname === "/" && request.method === "GET") return connectionPage();
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    if (request.method !== "POST" && request.method !== "OPTIONS") {
      return publicResponse(new Response("Method not allowed", { status: 405, headers: { allow: "POST, OPTIONS" } }));
    }
    if (request.method === "OPTIONS") return publicResponse(new Response(null, { status: 204 }));

    const denied = await admitMcpRequest(request, env.MCP_RATE_LIMITER);
    if (denied !== undefined) return publicResponse(denied);
    if (env.PONEGLYPH === undefined) return publicResponse(new Response("Database binding is unavailable", { status: 503 }));
    const handler = createPoneglyphMcpHandler({
      reader: createGraphReader(env.PONEGLYPH),
      dataset: DATASET,
      serverInfo: { name: "poneglyph-onepiece-playground", version: "0.1.0" },
      allowedHostnames: ALLOWED_HOSTS,
    });
    return publicResponse(await handler.fetch(request));
  },
} satisfies ExportedHandler<PlaygroundEnv>;

function publicResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  headers.set("access-control-allow-headers", "Content-Type, MCP-Protocol-Version, MCP-Session-Id, MCP-Client-Info, MCP-Client-Capabilities, MCP-Client-Request-State");
  headers.set("access-control-expose-headers", "Retry-After, MCP-Protocol-Version");
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
