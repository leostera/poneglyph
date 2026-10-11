export { GraphCoordinatorDO } from "./coordinator.js";
export { BenchCoordinatorDO, BenchShardDO } from "./benchmark.js";
export { shardObjectName, parseVirtualPrefix } from "./keys.js";
export { GraphShardDO } from "./shard.js";
export { coordinatorObjectName } from "./keys.js";
import { coordinatorObjectName } from "./keys.js";
import type { FetchNamespace } from "../storage-namespace.js";

export function dispatchGraphRequest(request: Request, env: Readonly<{ GRAPH_COORDINATORS: FetchNamespace }>, graphId: string): Promise<Response> {
  return env.GRAPH_COORDINATORS.getByName(coordinatorObjectName(graphId)).fetch(request);
}
