export { GraphCoordinatorDO } from "./coordinator-facade.js";
export { GraphLedgerDO } from "./ledger-do.js";
export { GraphTreeDO } from "./coordinator.js";
export { BenchCoordinatorDO, BenchShardDO } from "./benchmark.js";
export { shardObjectName, parseVirtualPrefix } from "./keys.js";
export { GraphShardDO } from "./shard.js";
export { coordinatorObjectName } from "./keys.js";
import { coordinatorObjectName } from "./keys.js";
import type { StorageEnv } from "./environment.js";

export async function dispatchGraphRequest(request: Request, env: StorageEnv, graphId: string): Promise<Response> {
  return env.GRAPH_FACADES.getByName(coordinatorObjectName(graphId)).fetch(request);
}
