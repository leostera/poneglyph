import { createPublicPoneglyphMcpWorker } from "@leostera/poneglyph-mcp";
import type { InferEnv } from "cf/config";
import type { playgroundBindings } from "../cloudflare.config.ts";
import { createApiHandler } from "./api.js";
import { CONNECTION_TEXT, DATASET, EXAMPLE_QUERIES, MCP_URL, PUBLIC_HOST } from "./dataset.js";
import { admitMcpRequest } from "./rate-limit.js";
import { GRAPH_ID } from "./runtime.js";

type PlaygroundEnv = InferEnv<{ env: typeof playgroundBindings }>;

const ALLOWED_HOSTS = [PUBLIC_HOST, "localhost", "127.0.0.1", "[::1]"];

const mcpWorker = createPublicPoneglyphMcpWorker<PlaygroundEnv>({
  graphId: GRAPH_ID,
  service: env => env.PONEGLYPH,
  admit: (request, env) => admitMcpRequest(request, env.MCP_RATE_LIMITER),
  dataset: DATASET,
  serverInfo: { name: "poneglyph-onepiece-playground", version: "0.2.0" },
  allowedHostnames: ALLOWED_HOSTS,
  // The browser app owns "/"; this is never reached because "/" is routed to assets.
  homepage: () => new Response(null, { status: 404 }),
});

const api = createApiHandler({
  host: PUBLIC_HOST,
  graphId: GRAPH_ID,
  session: { dataset: { name: DATASET.name, note: DATASET.currentDataNote, limitations: DATASET.limitations, entityIdentity: DATASET.entityIdentity, queryLanguage: DATASET.queryLanguage }, examples: EXAMPLE_QUERIES, mcp: { url: MCP_URL, instructions: CONNECTION_TEXT } },
});

// Static assets are served through the Worker (runWorkerFirst) so every
// response carries the same security headers and Access context is available.
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self' data:",
  "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'",
].join("; ");

async function asset(request: Request, env: PlaygroundEnv): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", CONTENT_SECURITY_POLICY);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: PlaygroundEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!ALLOWED_HOSTS.includes(url.hostname)) return new Response("Invalid host", { status: 403 });
    if (url.pathname === "/mcp") return mcpWorker.fetch(request, env);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return api(request, env, ctx);
    return asset(request, env);
  },
} satisfies ExportedHandler<PlaygroundEnv>;
