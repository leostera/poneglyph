import { jsonResponse } from "../storage/http.js";
import { hasSameOriginWebSocket, handleTodoLogin, hasTodoSession } from "./auth.js";
import { TODO_PAGE } from "./page.js";
import { handleTodoApi, TODO_GRAPH_ID } from "./service.js";

export async function handleTodoRequest(request: Request, env: Env): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path === "/todo" && request.method === "GET") {
    return new Response(TODO_PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (path === "/api/todo/login" && request.method === "POST") {
    if (!hasSameOriginHttp(request)) return jsonResponse({ error: "same-origin request required" }, 403);
    return handleTodoLogin(request, env);
  }
  const graphPath = /^\/v1\/graphs\/([^/]+)\//.exec(path);
  const isSharedTodoGraph = graphPath !== null && decodeURIComponent(graphPath[1] ?? "") === TODO_GRAPH_ID;
  if (!path.startsWith("/api/todo/") && !isSharedTodoGraph) return undefined;
  if (request.method === "POST" && !hasSameOriginHttp(request)) {
    return jsonResponse({ error: "same-origin request required" }, 403);
  }
  if (!(await hasTodoSession(request, env))) return jsonResponse({ error: "authentication required" }, 401);
  if (isSharedTodoGraph) {
    if (request.method === "POST" && graphPath?.[1] === TODO_GRAPH_ID && path.endsWith("/transactions")) {
      return jsonResponse({ error: "shared TODO writes must use the authenticated reactive API" }, 403);
    }
    return undefined;
  }
  if (path === "/api/todo/ws") {
    if (!hasSameOriginWebSocket(request)) return jsonResponse({ error: "same-origin HTTPS WebSocket required" }, 403);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return jsonResponse({ error: "WebSocket upgrade required" }, 426);
    const hub = env.TODO_HUBS.getByName("shared-todo");
    return hub.fetch(new Request("https://todo-hub.internal/connect", { headers: { upgrade: "websocket" } }));
  }
  return handleTodoApi(request, env);
}

function hasSameOriginHttp(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
