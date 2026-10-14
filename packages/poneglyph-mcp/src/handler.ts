import { readRequestBody } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { createPoneglyphMcpServer, type PoneglyphMcpServerOptions } from "./server.js";

export type PoneglyphMcpHandlerOptions = PoneglyphMcpServerOptions & Readonly<{
  allowedHostnames: readonly string[];
  route?: string;
}>;
export type PoneglyphMcpHandler = Readonly<{ fetch(request: Request): Promise<Response> }>;
const MAX_REQUEST_BYTES = 65_536;

// Applications own ingress authentication/rate admission and CORS. Invoke this
// only after admission. No binding, graph ID, hostname or corpus is hardcoded.
export function createPoneglyphMcpHandler(options: PoneglyphMcpHandlerOptions): PoneglyphMcpHandler {
  const route = options.route ?? "/mcp";
  return {
    async fetch(request) {
      if (new URL(request.url).pathname !== route) return new Response("Not found", { status: 404 });
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
      if (!options.allowedHostnames.includes(new URL(request.url).hostname)) return new Response("Invalid host", { status: 403 });
      // Agents 0.28.1's legacy compatibility lane doesn't forward the SDK body
      // limit. Establish it before either lane classifies/parses the message.
      const body = await readRequestBody(request, MAX_REQUEST_BYTES);
      if (body.tooLarge) return Response.json({ error: `MCP request body exceeds ${MAX_REQUEST_BYTES} bytes` }, { status: 413 });
      let parsedBody: unknown;
      try { parsedBody = JSON.parse(body.text); }
      catch { return Response.json({ error: "Invalid MCP JSON" }, { status: 400 }); }
      // One admitted POST must not fan out into many queries via legacy batching.
      if (Array.isArray(parsedBody)) return Response.json({ error: "MCP request batching is not supported" }, { status: 400 });
      const handler = createMcpHandler(() => createPoneglyphMcpServer(options), {
        route,
        maxRequestBodySize: MAX_REQUEST_BYTES,
        maxSubscriptions: 0,
        legacy: "stateless",
        allowedHostnames: [...options.allowedHostnames],
        // The owner may enforce an Origin/access policy before this handler.
        allowedOriginHostnames: "*",
        corsOptions: false,
      });
      return handler.fetch(request, { parsedBody });
    },
  };
}
