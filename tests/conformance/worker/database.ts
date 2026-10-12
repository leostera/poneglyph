import original, { TodoHubDO } from "../../../poneglyph/src/worker.js";
import { GraphCoordinatorDO, GraphShardDO, shardObjectName, parseVirtualPrefix } from "../../../poneglyph/src/database-implementation.js";

declare const __E2E_OWNER_DEPTH__: number;
export {TodoHubDO};
export class InspectionCoordinatorDO extends GraphCoordinatorDO {}
export class InspectionShardDO extends GraphShardDO {
  async inspection(prefix: string, table: string, after: number) {
    // B1+ have sixteen virtual owner roots; these upper nodes contain no data.
    if (prefix.length < __E2E_OWNER_DEPTH__) return {children: [`${prefix}0`, `${prefix}1`], rows: []};
    const identity = this.ctx.storage.sql.exec<{role: string; child_zero_prefix: string; child_one_prefix: string}>("SELECT * FROM shard_identity").toArray()[0];
    if (identity?.role === "router") return {children: [identity.child_zero_prefix, identity.child_one_prefix], rows: []};
    const current = table === "fact_log" ? "" : " AND valid_to_seq IS NULL";
    return {children: [], rows: this.ctx.storage.sql.exec(
      `SELECT rowid AS cursor, * FROM ${table} WHERE rowid > ?${current} ORDER BY rowid LIMIT 128`, after).toArray()};
  }
}
interface InspectionEnv extends Env {GRAPH_COORDINATORS: DurableObjectNamespace<InspectionCoordinatorDO>; GRAPH_SHARDS: DurableObjectNamespace<InspectionShardDO>; AUDIT_TOKEN: string}
export default {
  async fetch(request: Request, env: InspectionEnv) {
    const url = new URL(request.url);
    if (url.pathname === "/__e2e/inspect") {
      if (request.headers.get("authorization") !== `Bearer ${env.AUDIT_TOKEN}`) return new Response("unauthorized", {status: 401});
      const graph = url.searchParams.get("graph"), prefix = parseVirtualPrefix(url.searchParams.get("prefix") ?? "");
      const table = url.searchParams.get("table") ?? "fact_log", after = Number(url.searchParams.get("after") ?? 0);
      if (!graph || !prefix.ok || !Number.isSafeInteger(after) || after < 0 ||
          !["fact_log", "active_facts", "active_values", "entity_versions"].includes(table)) return new Response("bad inspection", {status: 400});
      const stub = env.GRAPH_SHARDS.getByName(shardObjectName(graph, prefix.value));
      return Response.json(await stub.inspection(prefix.value, table, after));
    }
    return original.fetch(request, env);
  },
};
