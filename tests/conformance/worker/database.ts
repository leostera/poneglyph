import original, { TodoHubDO } from "../../../poneglyph/src/worker.js";
import { GraphCoordinatorDO, GraphShardDO, shardObjectName, parseVirtualPrefix } from "../../../poneglyph/src/database-implementation.js";

import {parseReadFaultMode, transformRead, type ReadFaultMode} from "./read-fault.js";
import {WriteBarrier} from "./write-barrier.js";

declare const __E2E_OWNER_DEPTH__: number;
export {TodoHubDO};
export class InspectionCoordinatorDO extends GraphCoordinatorDO {}
export class InspectionShardDO extends GraphShardDO {
  private readFault: ReadFaultMode = "none";
  private faultHits = 0;
  private successfulScans = 0;
  private readonly writeBarrier = new WriteBarrier();
  writeBarrierStatus() {return this.writeBarrier.status();}
  armWriteBarrier(input: unknown) {return this.writeBarrier.arm(input);}
  releaseWriteBarrier() {return this.writeBarrier.release();}
  clearWriteBarrier() {return this.writeBarrier.clear();}
  configureReadFault(input: unknown) {
    const mode = parseReadFaultMode(input);
    const previous = this.readFaultStatus();
    this.readFault = mode; this.faultHits = 0; this.successfulScans = 0;
    return previous;
  }
  readFaultStatus() {return {mode: this.readFault, hits: this.faultHits, successfulScans: this.successfulScans};}
  override async fetch(request: Request): Promise<Response> {
    return this.writeBarrier.intercept(request, () => this.fetchWithReadFault(request));
  }
  private async fetchWithReadFault(request: Request): Promise<Response> {
    const mode = this.readFault;
    if (new URL(request.url).pathname !== "/_scan" || mode === "none") return super.fetch(request);
    this.faultHits++;
    if (mode === "unavailable-before") return Response.json({error: "injected unavailable scan participant"}, {status: 503});
    const response = await super.fetch(request);
    if (response.ok) this.successfulScans++;
    return transformRead(response, mode);
  }
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
    if (url.pathname === "/__e2e/write-barrier") {
      if (request.headers.get("authorization") !== `Bearer ${env.AUDIT_TOKEN}`) return new Response("unauthorized", {status: 401});
      const graph = url.searchParams.get("graph"), prefix = parseVirtualPrefix(url.searchParams.get("prefix") ?? "");
      if (!graph || !prefix.ok) return new Response("bad barrier identity", {status: 400});
      const stub = env.GRAPH_SHARDS.getByName(shardObjectName(graph, prefix.value));
      if (request.method === "GET") return Response.json(await stub.writeBarrierStatus());
      try {
        const action = url.searchParams.get("action");
        if (action === "arm") return Response.json(await stub.armWriteBarrier(await request.json()));
        if (action === "release") return Response.json(await stub.releaseWriteBarrier());
        if (action === "clear") return Response.json(await stub.clearWriteBarrier());
      } catch (error) {return Response.json({error: String(error)}, {status: 400});}
      return new Response("invalid barrier action", {status: 400});
    }
    if (url.pathname === "/__e2e/read-fault") {
      if (request.headers.get("authorization") !== `Bearer ${env.AUDIT_TOKEN}`) return new Response("unauthorized", {status: 401});
      const graph = url.searchParams.get("graph"), prefix = parseVirtualPrefix(url.searchParams.get("prefix") ?? "");
      if (!graph || !prefix.ok) return new Response("bad fault identity", {status: 400});
      const stub = env.GRAPH_SHARDS.getByName(shardObjectName(graph, prefix.value));
      if (request.method === "GET") return Response.json(await stub.readFaultStatus());
      const body: unknown = await request.json();
      try {return Response.json(await stub.configureReadFault(body));}
      catch {return new Response("invalid fault control", {status: 400});}
    }
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
