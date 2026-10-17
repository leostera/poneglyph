import { parseGraphId } from "./domain/graph-id.js";
import type { StorageEnv } from "./storage/environment.js";
import { jsonResponse } from "./storage/http.js";
import { dispatchGraphRequest } from "./storage/implementation.js";
import { handleTodoRequest } from "./todo_demo/worker.js";

export { GraphCoordinatorDO, GraphLedgerDO, GraphTreeDO, GraphShardDO } from "./storage/implementation.js";
export { TodoHubDO } from "./todo_demo/hub.js";

export default {
  async fetch(request: Request, env: Env & StorageEnv): Promise<Response> {
    const todo = await handleTodoRequest(request, env);
    if (todo !== undefined) return todo;

    const match = /^\/v1\/graphs\/([^/]+)\/(transactions|query|schema|entities)$/.exec(new URL(request.url).pathname);
    if (match === null) return jsonResponse({ error: "not found" }, 404);
    const graphId = parseGraphId(match[1]);
    if (!graphId.ok) return jsonResponse({ error: graphId.error.message, path: graphId.error.path }, 400);

    return dispatchGraphRequest(request, env, graphId.value);
  },
};
