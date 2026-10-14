import { createPoneglyphMcpHandler } from "./handler.js";
import type { PoneglyphMcpServerOptions, ScopedGraphReader } from "./server.js";

export interface GraphService {
  getGraph(input: { graphId: string }): Promise<ScopedGraphReader>;
}
export type PublicMcpWorkerOptions<Env> = Readonly<{
  dataset: PoneglyphMcpServerOptions["dataset"];
  serverInfo?: PoneglyphMcpServerOptions["serverInfo"];
  instructions?: string;
  allowedHostnames: readonly string[];
  graphId: string;
  service(env: Env): GraphService | undefined;
  admit(request: Request, env: Env): Promise<Response | undefined>;
  homepage(): Response;
}>;

// Explicitly PUBLIC/anonymous/read-only composition. Applications own admission,
// service identity/graph selection and content; no corpus or binding is baked in.
export function createPublicPoneglyphMcpWorker<Env>(options: PublicMcpWorkerOptions<Env>) {
  const allowedHostnames = [...options.allowedHostnames];
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      if (!allowedHostnames.includes(url.hostname)) return new Response("Invalid host", { status: 403 });
      if (url.pathname === "/" && request.method === "GET") return options.homepage();
      if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
      if (request.method === "OPTIONS") return publicResponse(new Response(null, { status: 204 }));
      if (request.method !== "POST") return publicResponse(new Response("Method not allowed", { status: 405, headers: { allow: "POST, OPTIONS" } }));
      const denied = await options.admit(request, env);
      if (denied !== undefined) return publicResponse(denied);
      const service = options.service(env);
      if (service === undefined) return publicResponse(new Response("Database binding is unavailable", { status: 503 }));
      const handler = createPoneglyphMcpHandler({
        dataset: options.dataset, serverInfo: options.serverInfo, instructions: options.instructions,
        allowedHostnames, getGraph: () => service.getGraph({ graphId: options.graphId }),
      });
      return publicResponse(await handler.fetch(request));
    },
  };
}
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
