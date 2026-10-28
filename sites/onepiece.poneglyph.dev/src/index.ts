import { createPublicPoneglyphMcpWorker } from "@leostera/poneglyph-mcp";
import type { InferEnv } from "cf/config";
import type { playgroundBindings } from "../cloudflare.config.ts";
import clientAssets from "virtual:playground-client";
import { createApiHandler } from "./api.js";
import { ABOUT, CONNECTION_TEXT, DATASET, EXAMPLE_QUERIES, MCP_URL, PUBLIC_HOST } from "./dataset.js";
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
  // The browser app owns "/"; this is never reached because "/" is served by `client` below.
  homepage: () => new Response(null, { status: 404 }),
});

const api = createApiHandler({
  host: PUBLIC_HOST,
  graphId: GRAPH_ID,
  session: { about: ABOUT, examples: EXAMPLE_QUERIES, mcp: { url: MCP_URL, instructions: CONNECTION_TEXT } },
});

// The client is embedded in this bundle (no static-assets router) and served
// by Worker code with security headers. See build/client-assets.ts.
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self' data:",
  "connect-src 'self'", "worker-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'",
].join("; ");
const decoded = new Map<string, Uint8Array<ArrayBuffer>>();

function client(request: Request): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  const path = new URL(request.url).pathname;
  const exact = clientAssets[path];
  // SPA fallback: unknown extension-less paths render the app; unknown files are 404.
  const asset = exact ?? (/\.[a-z0-9]+$/i.test(path) ? undefined : clientAssets["/index.html"]);
  if (asset === undefined) return new Response("Not found", { status: 404 });
  const headers = new Headers({
    "content-type": asset.type,
    etag: asset.etag,
    "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  });
  if (request.headers.get("if-none-match") === asset.etag) return new Response(null, { status: 304, headers });
  let body: string | Uint8Array<ArrayBuffer> | undefined = asset.text;
  if (body === undefined) {
    body = decoded.get(path) ?? Uint8Array.from(atob(asset.base64 ?? ""), character => character.charCodeAt(0));
    decoded.set(path, body);
  }
  return new Response(request.method === "HEAD" ? null : body, { headers });
}

export default {
  async fetch(request: Request, env: PlaygroundEnv): Promise<Response> {
    const url = new URL(request.url);
    if (!ALLOWED_HOSTS.includes(url.hostname)) return new Response("Invalid host", { status: 403 });
    if (url.pathname === "/mcp") return mcpWorker.fetch(request, env);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return api(request, env);
    return client(request);
  },
} satisfies ExportedHandler<PlaygroundEnv>;
