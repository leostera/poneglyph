import { createMcpHandler } from "agents/mcp/server";
import { readRequestBody } from "@modelcontextprotocol/server";
import type { InferEnv } from "cf/config";
import type { playgroundBindings } from "../cloudflare.config.ts";
import { createServer } from "./mcp.js";
import { connectionPage } from "./page.js";
import { createGraphReader } from "./reader.js";
import { PUBLIC_HOST } from "./dataset.js";
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
    // Agents 0.28.1's legacy compatibility lane doesn't forward the SDK body
    // limit. Establish it before either lane classifies/parses an MCP request.
    const body = await readRequestBody(request, 65_536);
    if (body.tooLarge) return publicResponse(Response.json({ error: "MCP request body exceeds 65536 bytes" }, { status: 413 }));
    let parsedBody: unknown;
    try { parsedBody = JSON.parse(body.text); }
    catch { return publicResponse(Response.json({ error: "Invalid MCP JSON" }, { status: 400 })); }
    // One admitted POST must not fan out into many queries via a legacy batch.
    if (Array.isArray(parsedBody)) return publicResponse(Response.json({ error: "MCP request batching is not supported" }, { status: 400 }));
    const reader = createGraphReader(env.PONEGLYPH);
    // Both handler and server are request-local: no shared connected server,
    // cross-request transport state, or MCP session DO is needed for these tools.
    const handler = createMcpHandler(() => createServer(reader), {
      route: "/mcp",
      maxRequestBodySize: 65_536,
      maxSubscriptions: 0, // request/response tools only; no public idle streams
      legacy: "stateless",
      allowedHostnames: ALLOWED_HOSTS,
      // Deliberately public, including browser-based agents. Host validation
      // remains strict; CORS is not authorization and no credentials are needed.
      allowedOriginHostnames: "*",
      corsOptions: false,
    });
    return publicResponse(await handler.fetch(request, { parsedBody }));
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
