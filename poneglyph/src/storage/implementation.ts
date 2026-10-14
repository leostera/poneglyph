export { GraphCoordinatorDO } from "./coordinator.js";
export { BenchCoordinatorDO, BenchShardDO } from "./benchmark.js";
export { shardObjectName, parseVirtualPrefix } from "./keys.js";
export { GraphShardDO } from "./shard.js";
export { coordinatorObjectName } from "./keys.js";
import { coordinatorObjectName } from "./keys.js";
import { transactionCoordinatorName } from "./forest.js";
import { MAX_TRANSACTION_BYTES, MAX_TRANSACTION_FACTS } from "./constants.js";
import { readJsonBody, parseBatchBody, jsonResponse } from "./http.js";
import type { StorageEnv } from "./environment.js";

export async function dispatchGraphRequest(request: Request, env: StorageEnv, graphId: string): Promise<Response> {
  if (request.method === "POST" && new URL(request.url).pathname.endsWith("/transactions")) {
    const raw = await readJsonBody(request, MAX_TRANSACTION_BYTES);
    if (!raw.ok) return jsonResponse({ error: raw.error.message }, 400);
    const parsed = parseBatchBody(raw.value);
    if (!parsed.ok) return jsonResponse({ error: parsed.error.message }, 400);
    if (parsed.value.batch.facts.length > MAX_TRANSACTION_FACTS || new TextEncoder().encode(parsed.value.json).byteLength > MAX_TRANSACTION_BYTES)
      return jsonResponse({ error: "transaction exceeds fact/byte limits", retryable: false }, 413);
    return env.GRAPH_COORDINATORS.getByName(await transactionCoordinatorName(graphId, parsed.value.batch.txId)).fetch("https://transaction.internal/_transact", {
      method: "POST", body: JSON.stringify({ graphId, batch: parsed.value.batch }),
    });
  }
  return env.GRAPH_COORDINATORS.getByName(coordinatorObjectName(graphId)).fetch(request);
}
