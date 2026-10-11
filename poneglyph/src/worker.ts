import { parseGraphId } from "./domain/graph-id.js";
import { jsonResponse } from "./storage/http.js";
import { coordinatorObjectName } from "./database-implementation.js";
import { handleTodoRequest } from "./todo_demo/worker.js";

export { GraphCoordinatorDO, GraphShardDO } from "./database-implementation.js";
export { TodoHubDO } from "./todo_demo/hub.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const todo = await handleTodoRequest(request, env);
    if (todo !== undefined) return todo;

    const match = /^\/v1\/graphs\/([^/]+)\/(transactions|query|entities)$/.exec(new URL(request.url).pathname);
    if (match === null) return jsonResponse({ error: "not found" }, 404);
    const graphId = parseGraphId(match[1]);
    if (!graphId.ok) return jsonResponse({ error: graphId.error.message, path: graphId.error.path }, 400);

    const coordinator = env.GRAPH_COORDINATORS.getByName(coordinatorObjectName(graphId.value));
    return coordinator.fetch(request);
  },
};
