import original, { TodoHubDO } from "../../../poneglyph/src/worker.js";
import { GraphCoordinatorDO, GraphShardDO, shardObjectName, coordinatorObjectName, parseVirtualPrefix } from "../../../poneglyph/src/database-implementation.js";

import {parseReadFaultMode, transformRead, type ReadFaultMode} from "./read-fault.js";
import {WriteBarrier} from "./write-barrier.js";
import {ApplyGate} from "./apply-gate.js";
import {authorityActors, authorityLayout, ownerActorName} from "./authority-placement.js";
import {coordinatorAuthority, shardAuthority, ownerWitness, participantStage, type AuthorityRole} from "./authority-sql.js";
import {parseReply} from "../response-evidence.js";
import {parseAuthorityIdentities} from "./authority-controls.js";

declare const __E2E_OWNER_DEPTH__: number;
export {TodoHubDO};
export class InspectionCoordinatorDO extends GraphCoordinatorDO {
  authorityStatus(role: AuthorityRole, after: number) {return coordinatorAuthority(this.ctx.storage, authorityLayout, role, after);}
  ownerWitness(txId: string) {return ownerWitness(this.ctx.storage, txId);}
}
export class InspectionShardDO extends GraphShardDO {
  authorityStatus(after: number) {return shardAuthority(this.ctx.storage, authorityLayout, after);}
  participantStage(txId: string) {return participantStage(this.ctx.storage, txId);}
  private readonly applyGate = new ApplyGate();
  applyGateStatus() {return this.applyGate.status();}
  armApplyGate(input: unknown) {return this.applyGate.arm(input);}
  clearApplyGate() {return this.applyGate.clear();}
  releaseApplyGate() {return this.applyGate.release();}
  private readonly incarnation = crypto.randomUUID();
  lifecycleStatus() {return {objectId: this.ctx.id.toString(), incarnation: this.incarnation};}
  terminateActor() {this.ctx.abort("conformance actual native actor reset");}
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
    return this.applyGate.intercept(request, () => this.writeBarrier.intercept(request, () => this.fetchWithReadFault(request)));
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
    if (url.pathname === "/__e2e/authority-actors") {
      if (request.headers.get("authorization") !== `Bearer ${env.AUDIT_TOKEN}`) return new Response("unauthorized", {status: 401});
      const graph = url.searchParams.get("graph");
      if (!graph) return new Response("missing authority graph", {status: 400});
      let ids: readonly string[];
      try {ids = parseAuthorityIdentities(parseReply(await request.json())["txIds"]);}
      catch (error) {return Response.json({error: String(error)}, {status: 400});}
      return Response.json(await authorityActors(graph, ids));
    }
    if (url.pathname === "/__e2e/coordinator-authority") {
      if (request.headers.get("authorization") !== `Bearer ${env.AUDIT_TOKEN}`) return new Response("unauthorized", {status: 401});
      const graph = url.searchParams.get("graph"), name = url.searchParams.get("name"), role = url.searchParams.get("role");
      const after = Number(url.searchParams.get("after") ?? 0);
      if (!graph || !name || !(name === coordinatorObjectName(graph) || name.startsWith(`${coordinatorObjectName(graph)}:`)) || (role !== "graph" && role !== "owner" && role !== "ledger") || !Number.isSafeInteger(after) || after < 0) return new Response("invalid authority inspection", {status: 400});
      return Response.json(await env.GRAPH_COORDINATORS.getByName(name).authorityStatus(role, after));
    }
    if (url.pathname === "/__e2e/owner-witness") {
      if (request.headers.get("authorization") !== `Bearer ${env.AUDIT_TOKEN}`) return new Response("unauthorized", {status: 401});
      const graph = url.searchParams.get("graph"), prefix = parseVirtualPrefix(url.searchParams.get("prefix") ?? "");
      const id = url.searchParams.get("txId");
      if (!graph || !prefix.ok || prefix.value.length !== __E2E_OWNER_DEPTH__ || !id || authorityLayout.publication !== "owner_released") return new Response("invalid owner witness request", {status: 400});
      const ids = parseAuthorityIdentities([id]);
      return Response.json(await env.GRAPH_COORDINATORS.getByName(ownerActorName(graph, prefix.value)).ownerWitness(ids[0]!));
    }
    if (url.pathname === "/__e2e/participant-stage" || url.pathname === "/__e2e/apply-gate") {
      if (request.headers.get("authorization") !== `Bearer ${env.AUDIT_TOKEN}`) return new Response("unauthorized", {status: 401});
      const graph = url.searchParams.get("graph"), prefix = parseVirtualPrefix(url.searchParams.get("prefix") ?? "");
      if (!graph || !prefix.ok || prefix.value.length < __E2E_OWNER_DEPTH__) return new Response("invalid participant identity", {status: 400});
      const stub = env.GRAPH_SHARDS.getByName(shardObjectName(graph, prefix.value));
      try {
        if (url.pathname === "/__e2e/participant-stage") {
          if (request.method !== "GET") return new Response("inspection requires GET", {status: 405});
          const ids = parseAuthorityIdentities([url.searchParams.get("txId")]);
          return Response.json(await stub.participantStage(ids[0]!));
        }
        if (request.method === "GET") return Response.json(await stub.applyGateStatus());
        if (request.method !== "POST") return new Response("control requires POST", {status: 405});
        const action = url.searchParams.get("action");
        if (action === "arm") return Response.json(await stub.armApplyGate(await request.json()));
        if (action === "clear") return Response.json(await stub.clearApplyGate());
        if (action === "release") return Response.json(await stub.releaseApplyGate());
      } catch (error) {return Response.json({error: String(error)}, {status: 400});}
      return new Response("invalid apply-gate action", {status: 400});
    }
    if (url.pathname === "/__e2e/shard-authority") {
      if (request.headers.get("authorization") !== `Bearer ${env.AUDIT_TOKEN}`) return new Response("unauthorized", {status: 401});
      const graph = url.searchParams.get("graph"), prefix = parseVirtualPrefix(url.searchParams.get("prefix") ?? "");
      const after = Number(url.searchParams.get("after") ?? 0);
      if (!graph || !prefix.ok || prefix.value.length < __E2E_OWNER_DEPTH__ || !Number.isSafeInteger(after) || after < 0) return new Response("invalid physical authority identity", {status: 400});
      return Response.json(await env.GRAPH_SHARDS.getByName(shardObjectName(graph, prefix.value)).authorityStatus(after));
    }
    if (url.pathname === "/__e2e/lifecycle") {
      if (request.headers.get("authorization") !== `Bearer ${env.AUDIT_TOKEN}`) return new Response("unauthorized", {status: 401});
      const graph = url.searchParams.get("graph"), prefix = parseVirtualPrefix(url.searchParams.get("prefix") ?? "");
      if (!graph || !prefix.ok) return new Response("invalid lifecycle identity", {status: 400});
      const stub = env.GRAPH_SHARDS.getByName(shardObjectName(graph, prefix.value));
      if (request.method === "GET") return Response.json(await stub.lifecycleStatus());
      if (request.method !== "POST") return new Response("abort requires POST", {status: 405});
      try {await stub.terminateActor();}
      catch (error) {return Response.json({action: "native-abort", requestInterrupted: true, error: String(error)}, {status: 503});}
      return Response.json({error: "native abort unexpectedly returned"}, {status: 500});
    }
    if (url.pathname === "/__e2e/split") {
      if (request.headers.get("authorization") !== `Bearer ${env.AUDIT_TOKEN}`) return new Response("unauthorized", {status: 401});
      if (request.method !== "POST") return new Response("split requires POST", {status: 405});
      const graph = url.searchParams.get("graph"), prefix = parseVirtualPrefix(url.searchParams.get("prefix") ?? "");
      const stop = url.searchParams.get("stopAfterPages");
      const pages = stop === null ? undefined : Number(stop);
      if (!graph || !prefix.ok || (pages !== undefined && (!Number.isSafeInteger(pages) || pages < 1))) return new Response("invalid split control", {status: 400});
      // Native migration only: force requests an actual small-data split, not
      // synthetic accounting/capacity or a SQL seed/repair path.
      return env.GRAPH_COORDINATORS.getByName(coordinatorObjectName(graph)).fetch("https://coordinator.internal/_split", {
        method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify({graphId: graph, prefix: prefix.value, force: true, ...(pages === undefined ? {} : {stopAfterPages: pages})}),
      });
    }
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
