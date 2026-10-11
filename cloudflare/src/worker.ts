import { parseGraphId } from "./domain/graph-id.js";
import { jsonResponse } from "./storage/http.js";
import { coordinatorObjectName } from "./storage/keys.js";

export { GraphCoordinatorDO } from "./storage/coordinator.js";
export { GraphShardDO } from "./storage/shard.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = /^\/v1\/graphs\/([^/]+)\/(transactions|query|entities)$/.exec(new URL(request.url).pathname);
    if (match === null) return jsonResponse({ error: "not found" }, 404);
    const graphId = parseGraphId(match[1]);
    if (!graphId.ok) return jsonResponse({ error: graphId.error.message, path: graphId.error.path }, 400);

    const coordinator = env.GRAPH_COORDINATORS.getByName(coordinatorObjectName(graphId.value));
    return coordinator.fetch(request);
  },
};
