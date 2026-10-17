import original, { TodoHubDO } from "../../poneglyph/src/worker.js";
import { BenchCoordinatorDO, BenchShardDO, GraphLedgerDO, GraphTreeDO, coordinatorObjectName, shardObjectName, parseVirtualPrefix } from "../../poneglyph/src/storage/implementation.js";

// Only SUT-specific read-only SQL wiring varies; workload and audit obligations
// remain in the same driver/ledger/verifier for the canonical implementation.
export { BenchCoordinatorDO, BenchShardDO, GraphLedgerDO, GraphTreeDO, TodoHubDO };
interface BenchmarkEnv extends Env {
  GRAPH_FACADES: DurableObjectNamespace<BenchCoordinatorDO>;
  GRAPH_LEDGERS: DurableObjectNamespace<GraphLedgerDO>;
  GRAPH_TREES: DurableObjectNamespace<GraphTreeDO>;
  GRAPH_SHARDS: DurableObjectNamespace<BenchShardDO>;
  GRAPH_ID: string;
  AUDIT_TOKEN: string;
}
export default {
  async fetch(request: Request, env: BenchmarkEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__bench/")) {
      if (!env.AUDIT_TOKEN || request.headers.get("authorization") !== `Bearer ${env.AUDIT_TOKEN}`) return new Response("unauthorized", { status: 401 });
      if (url.pathname === "/__bench/coordinator") return Response.json(await env.GRAPH_FACADES.getByName(coordinatorObjectName(env.GRAPH_ID)).audit());
      if (url.pathname === "/__bench/transaction") {
        const txId = url.searchParams.get("txId");
        if (!txId || txId.length > 512) return new Response("invalid transaction ID", {status: 400});
        return Response.json(await env.GRAPH_FACADES.getByName(coordinatorObjectName(env.GRAPH_ID)).transactionState(txId, env.GRAPH_ID));
      }
      if (url.pathname === "/__bench/shard") {
        const prefix = parseVirtualPrefix(url.searchParams.get("prefix") ?? "");
        const after = Number(url.searchParams.get("after") ?? 0);
        if (!prefix.ok || !Number.isSafeInteger(after) || after < 0) return new Response("bad cursor", { status: 400 });
        return Response.json(await env.GRAPH_SHARDS.getByName(shardObjectName(env.GRAPH_ID, prefix.value)).audit(after, env.GRAPH_ID, prefix.value));
      }
      return new Response("not found", { status: 404 });
    }
    return original.fetch(request, env);
  },
};
