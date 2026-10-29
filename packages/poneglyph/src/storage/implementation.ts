export { GraphCoordinatorDO } from "./coordinator-facade.js";
export { GraphLedgerDO } from "./ledger-do.js";
export { GraphTreeDO } from "./coordinator.js";
export { BenchCoordinatorDO, BenchShardDO } from "./benchmark.js";
export { shardObjectName, parseVirtualPrefix } from "./keys.js";
export { GraphShardDO } from "./shard.js";
export { coordinatorObjectName } from "./keys.js";
import { coordinatorObjectName } from "./keys.js";
import type { StorageEnv } from "./environment.js";
import { dispatchPublicTransaction } from "./transaction-request.js";

export async function dispatchGraphRequest(request: Request, env: StorageEnv, graphId: string): Promise<Response> {
  // Writes go straight to their ledger: the ledger name is derived from the
  // graph and transaction ID (or request token), so the per-graph facade adds
  // a hop and caps the graph's write rate without deciding anything.
  if (request.method === "POST" && new URL(request.url).pathname.endsWith("/transactions")) {
    return dispatchPublicTransaction(request, env, graphId);
  }
  return env.GRAPH_FACADES.getByName(coordinatorObjectName(graphId)).fetch(request);
}
