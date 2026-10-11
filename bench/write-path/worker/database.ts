import original, { GraphCoordinatorDO, GraphShardDO, TodoHubDO } from "../../../poneglyph/src/worker.js";
import { coordinatorObjectName, shardObjectName, parseVirtualPrefix } from "../../../poneglyph/src/storage/keys.js";

// Read-only benchmark audit methods. Production write methods are inherited unchanged.
export class BenchCoordinatorDO extends GraphCoordinatorDO {
  audit() {
    return {
      state: this.ctx.storage.sql.exec("SELECT * FROM graph_state").toArray(),
      phases: this.ctx.storage.sql.exec("SELECT phase, COUNT(*) AS count FROM graph_transactions GROUP BY phase").toArray(),
      databaseBytes: this.ctx.storage.sql.databaseSize,
    };
  }
}
export class BenchShardDO extends GraphShardDO {
  audit(after: number) {
    const identity = this.ctx.storage.sql.exec("SELECT * FROM shard_identity").toArray();
    if (identity[0]?.role === "router") return { identity, facts: [] };
    return {
      identity,
      facts: this.ctx.storage.sql.exec("SELECT rowid AS ordinal, tx_id, source, entity, field, value_json, retraction FROM fact_log WHERE rowid > ? ORDER BY rowid LIMIT 512", after).toArray(),
      ...(after === 0 ? {
      active: this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM active_facts WHERE valid_to_seq IS NULL").toArray(),
      maxCommitSeq: this.ctx.storage.sql.exec("SELECT COALESCE(MAX(commit_seq), 0) AS value FROM fact_log").toArray(),
      mismatchedFacts: this.ctx.storage.sql.exec(`SELECT COUNT(*) AS count FROM active_facts f LEFT JOIN fact_log l ON l.fact_id = f.fact_id
        WHERE f.valid_to_seq IS NULL AND (l.fact_id IS NULL OR l.retraction != 0 OR f.source != l.source OR f.entity != l.entity
        OR f.field != l.field OR f.value_json != l.value_json OR f.tx_id != l.tx_id OR f.valid_from_seq != l.commit_seq)`).toArray(),
      mismatchedDatalog: this.ctx.storage.sql.exec(`SELECT COUNT(*) AS count FROM active_values WHERE valid_to_seq IS NULL AND
        (datalog_value != json_extract(value_json, '$.value') OR datalog_type != CASE json_extract(value_json, '$.type') WHEN 'number' THEN 'integer' ELSE 'string' END)`).toArray(),
      values: this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM active_values WHERE valid_to_seq IS NULL").toArray(),
      mismatchedValues: this.ctx.storage.sql.exec(`SELECT COUNT(*) AS count FROM active_values v JOIN active_facts f ON f.fact_id = v.fact_id
        WHERE v.valid_to_seq IS NULL AND f.valid_to_seq IS NULL AND
        (v.entity != f.entity OR v.field != f.field OR v.source != f.source OR v.value_json != f.value_json OR v.value_key != f.value_json OR v.value_index != 0 OR v.valid_from_seq != f.valid_from_seq)`).toArray(),
      missingValues: this.ctx.storage.sql.exec(`SELECT COUNT(*) AS count FROM active_facts f WHERE f.valid_to_seq IS NULL AND NOT EXISTS
        (SELECT 1 FROM active_values v WHERE v.fact_id = f.fact_id AND v.valid_to_seq IS NULL)`).toArray(),
      orphanValues: this.ctx.storage.sql.exec(`SELECT COUNT(*) AS count FROM active_values v WHERE v.valid_to_seq IS NULL AND NOT EXISTS
        (SELECT 1 FROM active_facts f WHERE f.source = v.source AND f.entity = v.entity AND f.field = v.field
          AND f.value_json = v.value_json AND f.valid_to_seq IS NULL AND f.fact_id = v.fact_id)`).toArray(),
      statuses: this.ctx.storage.sql.exec("SELECT status, COUNT(*) AS count FROM shard_transactions GROUP BY status").toArray(),
      databaseBytes: this.ctx.storage.sql.databaseSize,
      } : {}),
    };
  }
}
export { TodoHubDO };
interface BenchmarkEnv extends Env {
  GRAPH_COORDINATORS: DurableObjectNamespace<BenchCoordinatorDO>;
  GRAPH_SHARDS: DurableObjectNamespace<BenchShardDO>;
  GRAPH_ID: string;
  AUDIT_TOKEN: string;
}
export default {
  async fetch(request: Request, env: BenchmarkEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__bench/")) {
      // Local-only entrypoint; cloud audit access must use a non-public service binding.
      if (!env.AUDIT_TOKEN || request.headers.get("authorization") !== `Bearer ${env.AUDIT_TOKEN}`) return new Response("unauthorized", { status: 401 });
      if (url.pathname === "/__bench/coordinator") return Response.json(await env.GRAPH_COORDINATORS.getByName(coordinatorObjectName(env.GRAPH_ID)).audit());
      if (url.pathname === "/__bench/shard") {
        const prefix = parseVirtualPrefix(url.searchParams.get("prefix") ?? "");
        const after = Number(url.searchParams.get("after") ?? 0);
        if (!prefix.ok || !Number.isSafeInteger(after) || after < 0) return new Response("bad cursor", { status: 400 });
        return Response.json(await env.GRAPH_SHARDS.getByName(shardObjectName(env.GRAPH_ID, prefix.value)).audit(after));
      }
      return new Response("not found", { status: 404 });
    }
    return original.fetch(request, env);
  },
};
