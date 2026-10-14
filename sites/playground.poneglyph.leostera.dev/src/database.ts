import { dispatchGraphRequest } from "../../../packages/poneglyph/src/storage/implementation.js";
import type { StorageEnv } from "../../../packages/poneglyph/src/storage/environment.js";
import { GRAPH_ID } from "./runtime.js";

// The same canonical runtime as production; no testing subclasses or backend fork.
export { GraphCoordinatorDO, GraphShardDO } from "../../../packages/poneglyph/src/storage/implementation.js";

// This Worker has no public routes/domain. Transactions are operator-only via
// a private binding/local runtime, never forwarded from the public MCP Worker.
export default {
  async fetch(request: Request, env: StorageEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || ![
      `/v1/graphs/${GRAPH_ID}/query`, `/v1/graphs/${GRAPH_ID}/transactions`,
    ].includes(path)) return new Response("Not found", { status: 404 });
    return dispatchGraphRequest(request, env, GRAPH_ID);
  },
} satisfies ExportedHandler<StorageEnv>;
