import {parseGraphId} from "../domain/graph-id.js";
import {isRecord} from "../domain/result.js";
import {parseDatalogQuery} from "../datalog/parser.js";
import type {StorageEnv} from "./environment.js";
import {
  MAX_QUERY_CACHE_BYTES, MAX_QUERY_CACHE_ENTRIES,
} from "./constants.js";
import {jsonResponse, readJsonBody} from "./http.js";
import {coordinatorObjectName, type VirtualPrefix} from "./keys.js";
import {BoundedReadCache, utf8Bytes} from "./read-cache.js";
import {queryReadPrefixes} from "./read-cut.js";
import {READ_HEAD_STATE_KEY, readHeadReplicaName, type ReadHeadReplicaIdentity} from "./read-head-placement.js";
import {
  EMPTY_READ_HEAD, applyReadHeadCommand, parseReadHeadCommand, parseReadHeadState, validateCompletedReadHead,
  type ReadHeadCommand, type ReadHeadState,
} from "./read-head-state.js";

class InvalidReadHeadQuery extends Error {}

function keys(raw: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(raw).length === expected.length && expected.every(key => Object.hasOwn(raw, key));
}

/**
 * Metadata-only facade-instance role. Canonical routes never reach this role.
 * Admission of every state-changing command requires the canonical parent's
 * current durable intent. This alone does NOT implement that parent adapter.
 */
export class ReadHeadReplica {
  private state: ReadHeadState;
  private readonly owners = new BoundedReadCache<readonly VirtualPrefix[]>(MAX_QUERY_CACHE_ENTRIES, MAX_QUERY_CACHE_BYTES);

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Pick<StorageEnv, "GRAPH_FACADES">,
    private readonly identity: ReadHeadReplicaIdentity,
  ) {
    // The facade resolves this identity from its durable role marker first;
    // idFromString callers have no name even for originally named objects.
    if (ctx.id.name !== undefined && ctx.id.name !== readHeadReplicaName(identity.graphId, identity.member)) {
      throw new Error("Read-head physical identity mismatch");
    }
    const raw: unknown = ctx.storage.kv.get(READ_HEAD_STATE_KEY);
    this.state = raw === undefined ? EMPTY_READ_HEAD : parseReadHeadState(raw);
    if (this.state.mode !== "empty" && (this.state.graphId !== identity.graphId || this.state.generation < identity.member)) {
      throw new Error("Read-head checkpoint identity mismatch");
    }
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") return jsonResponse({error: "not found"}, 404);
    if (path === "/_read-head-command") return this.command(request);
    if (path === "/_read-head-validate") return this.validate(request);
    return jsonResponse({error: "not found"}, 404);
  }

  private async authorized(command: ReadHeadCommand): Promise<boolean> {
    const response = await this.env.GRAPH_FACADES.getByName(coordinatorObjectName(this.identity.graphId)).fetch(
      "https://facade.internal/_read-head-authorize", {
        method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify({member: this.identity.member, command}),
      });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Read-head authority is unavailable");
    }
    const raw = await readJsonBody(response, 1_024);
    if (!raw.ok || !isRecord(raw.value) || !keys(raw.value, ["authorized"]) || typeof raw.value["authorized"] !== "boolean") {
      throw new Error("Read-head authority returned an invalid answer");
    }
    return raw.value["authorized"];
  }

  private async command(request: Request): Promise<Response> {
    const raw = await readJsonBody(request, 8_192);
    if (!raw.ok || !isRecord(raw.value) || !keys(raw.value, ["member", "command"]) || raw.value["member"] !== this.identity.member) {
      return jsonResponse({error: "invalid read-head command envelope"}, 400);
    }
    let command: ReadHeadCommand;
    try { command = parseReadHeadCommand(raw.value["command"]); }
    catch { return jsonResponse({error: "invalid read-head command"}, 400); }
    if (command.graphId !== this.identity.graphId || command.generation < this.identity.member) {
      return jsonResponse({error: "read-head command identity mismatch"}, 400);
    }
    // Harmless already-applied/stale/conflicting messages need no permission.
    // Re-check state after the authorization await: another command may advance
    // this actor while external I/O yields. Fencing prevents late resurrection.
    const proposed = applyReadHeadCommand(this.state, command);
    if (proposed.outcome !== "applied") return jsonResponse({outcome: proposed.outcome});
    try {
      if (!await this.authorized(command)) return jsonResponse({outcome: "conflict"});
    } catch {
      return jsonResponse({error: "read-head authority is unavailable", retryable: true}, 503);
    }
    const result = applyReadHeadCommand(this.state, command);
    if (result.outcome === "applied") {
      this.ctx.storage.transactionSync(() => this.ctx.storage.kv.put(READ_HEAD_STATE_KEY, result.state));
      // Persist first, then mirror; the runtime's output gate holds the reply
      // until durable storage succeeds. Failed commits cannot validate cache hits.
      this.state = result.state;
    }
    return jsonResponse({outcome: result.outcome});
  }

  private async prefixes(queryText: string): Promise<readonly VirtualPrefix[]> {
    const cacheKey = JSON.stringify([this.identity.graphId, queryText]);
    const cached = this.owners.get(cacheKey);
    if (cached !== undefined) return cached;
    const query = parseDatalogQuery(queryText);
    if (!query.ok) throw new InvalidReadHeadQuery();
    const prefixes = Object.freeze(await queryReadPrefixes(this.identity.graphId, query.value));
    this.owners.set(cacheKey, prefixes, utf8Bytes(JSON.stringify(prefixes)));
    return prefixes;
  }

  private async validate(request: Request): Promise<Response> {
    const raw = await readJsonBody(request, 16_384);
    if (!raw.ok || !isRecord(raw.value) || !keys(raw.value, ["graphId", "member", "query", "knownSnapshot"])) {
      return jsonResponse({error: "invalid read-head validation envelope"}, 400);
    }
    const graph = parseGraphId(raw.value["graphId"]), query = raw.value["query"];
    if (!graph.ok || graph.value !== this.identity.graphId || raw.value["member"] !== this.identity.member || typeof query !== "string") {
      return jsonResponse({error: "read-head validation identity mismatch"}, 400);
    }
    let expected: readonly VirtualPrefix[];
    try { expected = await this.prefixes(query); }
    catch (error) {
      return error instanceof InvalidReadHeadQuery ? jsonResponse({error: "invalid read-head query"}, 400) :
        jsonResponse({error: "read-head owner planning is unavailable", retryable: true}, 503);
    }
    try {
      // Linearize ONLY now, after asynchronous owner planning. No independently
      // assembled owner heads or time-based permissions are used.
      const decision = validateCompletedReadHead(this.state, graph.value, expected, raw.value["knownSnapshot"]);
      return jsonResponse(decision.kind === "unchanged" ? {unchanged: true, snapshotSeq: decision.snapshotSeq} : {canonical: true});
    } catch {
      return jsonResponse({error: "invalid read-head snapshot"}, 400);
    }
  }
}
