import { DurableObject, tracing } from "cloudflare:workers";
import { acquireParallelReadCut } from "./read-cut.js";
import type { StorageEnv as Env } from "./environment.js";
import { parseGraphId, type GraphId } from "../domain/graph-id.js";
import { parseUri } from "../domain/identifiers.js";
import { compareUnicodeScalars } from "../domain/string-order.js";
import { isRecord } from "../domain/result.js";
import { evaluateDatalog, QueryResultLimitExceeded } from "../datalog/evaluator.js";
import type { DatalogQuery } from "../datalog/ast.js";
import { parseDatalogQuery } from "../datalog/parser.js";
import { DistributedFactSource } from "./distributed-fact-source.js";
import { QueryScanBudgetExceeded } from "../datalog/scan-stream.js";
import {
  MAX_QUERY_RESPONSE_BYTES, MAX_QUERY_RESULTS, MAX_QUERY_SHARD_FANOUT,
  QUERY_TIMEOUT_MS,
} from "./constants.js";
import { jsonResponse, jsonStringResponse, readJsonBody, requestObject } from "./http.js";
import { parseVirtualPrefix, shardObjectName, virtualKeyForEntity, type VirtualPrefix } from "./keys.js";
import { listShardLeaves, resolveEntityLeaf } from "./routing.js";
import { dispatchPublicTransaction } from "./transaction-request.js";
import { TREE_PREFIXES, TREE_DEPTH, treeCoordinatorName, treeForKey, parseTreeSnapshot, type TreeSnapshot } from "./forest.js";

type FacadeEnv = Env;

/** Graph-facing request surface. Durable state lives in ledgers, trees, and shards. */
export class GraphCoordinatorDO extends DurableObject<FacadeEnv> {
  constructor(ctx: DurableObjectState, env: FacadeEnv) { super(ctx, env); }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/_split") {
      const raw = await readJsonBody(request, 8_192);
      if (!raw.ok || !isRecord(raw.value)) return jsonResponse({error: "invalid split envelope"}, 400);
      const graph = parseGraphId(raw.value["graphId"]);
      const prefix = parseVirtualPrefix(raw.value["prefix"]);
      if (!graph.ok || !prefix.ok || prefix.value.length < TREE_DEPTH) {
        return jsonResponse({error: "cannot split a virtual forest router"}, 400);
      }
      const root = prefix.value.slice(0, TREE_DEPTH) as VirtualPrefix;
      return this.env.GRAPH_TREES.getByName(treeCoordinatorName(graph.value, root)).fetch("https://tree.internal/_tree-split", {
        method: "POST", body: JSON.stringify({...raw.value, prefix: root, sourcePrefix: prefix.value}),
      });
    }

    const route = parseGraphRoute(request);
    if (route === undefined) return jsonResponse({error: "not found"}, 404);
    try {
      if (route.action === "transactions" && request.method === "POST") {
        return dispatchPublicTransaction(request, this.env, route.graphId);
      }
      if (route.action === "query" && request.method === "POST") return await this.runQuery(request, route.graphId);
      if (route.action === "schema" && request.method === "POST") return await this.observeGraphSchema(request, route.graphId);
      if (route.action === "entities" && request.method === "GET") return await this.readEntity(request, route.graphId);
      return jsonResponse({error: "method not allowed"}, 405);
    } catch (error) {
      const status = error instanceof CoordinatorError ? error.status : 503;
      return jsonResponse({error: errorMessage(error), retryable: error instanceof CoordinatorError ? error.retryable : true}, status);
    }
  }

  private async observeGraphSchema(request: Request, graphId: GraphId): Promise<Response> {
    const raw = await readJsonBody(request, 1_024);
    if (!raw.ok || !isRecord(raw.value) || Object.keys(raw.value).length !== 0) {
      return jsonResponse({error: "schema observation accepts an empty object"}, 400);
    }

    const cut = await this.acquireReadCut(graphId);
    try {
      const listings = await Promise.all(cut.map(snapshot =>
        listShardLeaves(this.env, graphId, snapshot.directoryEpoch, snapshot.prefix as VirtualPrefix)));
      const leaves = listings.flatMap((listing, index) => listing.leaves.map(address => ({snapshot: cut[index]!, address})));
      if (leaves.length > MAX_QUERY_SHARD_FANOUT * TREE_PREFIXES.length) {
        return jsonResponse({error: "schema observation exceeds the owner fan-out budget"}, 413);
      }

      const pairSet = new Set<string>();
      const pairs: {field: string; valueTag: string}[] = [];
      let next = 0;
      let stopped = false;
      const startedAt = Date.now();
      const readLeaf = async () => {
        try {
          while (!stopped) {
            if (Date.now() - startedAt >= QUERY_TIMEOUT_MS) {
              throw new CoordinatorError(408, "schema observation exceeded its time budget");
            }
            const index = next++;
            const item = leaves[index];
            if (item === undefined) return;
            const response = await this.env.GRAPH_SHARDS.getByName(shardObjectName(graphId, item.address.prefix)).fetch("https://shard.internal/_schema", {
              method: "POST",
              body: JSON.stringify({graphId, shardPrefix: item.address.prefix, shardGeneration: item.address.generation,
                directoryEpoch: item.snapshot.directoryEpoch, snapshotSeq: item.snapshot.snapshotSeq,
                leaseExpiresAtMs: item.snapshot.expiresAtMs}),
            });
            if (!response.ok) throw new CoordinatorError(response.status, "schema observation failed at an owner shard");
            let body: unknown;
            try { body = await response.json(); }
            catch { throw new CoordinatorError(502, "owner shard returned invalid schema observation data"); }
            if (!isRecord(body) || !Array.isArray(body["observations"])) {
              throw new CoordinatorError(502, "owner shard returned invalid schema observation data");
            }
            for (const observation of body["observations"]) {
              if (!isRecord(observation) || typeof observation["field"] !== "string" ||
                  typeof observation["valueTag"] !== "string" || !OBSERVED_VALUE_TAGS.has(observation["valueTag"])) {
                throw new CoordinatorError(502, "owner shard returned an invalid field/value tag");
              }
              const key = `${observation["field"]}\u0000${observation["valueTag"]}`;
              if (pairSet.has(key)) continue;
              pairSet.add(key);
              pairs.push({field: observation["field"], valueTag: observation["valueTag"]});
              if (pairs.length > MAX_QUERY_RESULTS) {
                throw new CoordinatorError(413, "schema observation exceeds the field/tag budget");
              }
            }
          }
        } catch (error) {
          stopped = true;
          throw error;
        }
      };
      const workerCount = Math.min(16, leaves.length);
      const workers = await Promise.allSettled(Array.from({length: workerCount}, () => readLeaf()));
      const failure = workers.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;

      const fields = new Map<string, Set<string>>();
      for (const pair of pairs) {
        const tags = fields.get(pair.field) ?? new Set<string>();
        tags.add(pair.valueTag);
        fields.set(pair.field, tags);
      }
      const observedFields = [...fields.entries()]
        .sort(([left], [right]) => compareUnicodeScalars(left, right))
        .map(([field, tags]) => ({field, valueTags: [...tags].sort(compareUnicodeScalars)}));
      const snapshotSeq = Math.max(...cut.map(snapshot => snapshot.snapshotSeq));
      const result = {snapshotSeq, sequenceScope: "subtree-vector", snapshotVector: cut.map(snapshot =>
        ({prefix: snapshot.prefix, sequence: snapshot.snapshotSeq, epoch: snapshot.directoryEpoch})), fields: observedFields};
      const serialized = JSON.stringify(result);
      if (new TextEncoder().encode(serialized).byteLength > MAX_QUERY_RESPONSE_BYTES) {
        return jsonResponse({error: "complete schema observation exceeds the response byte budget"}, 413);
      }
      return jsonStringResponse(serialized);
    } finally {
      await this.releaseReadCut(graphId, cut);
    }
  }

  private async runQuery(request: Request, graphId: GraphId): Promise<Response> {
    return tracing.enterSpan("poneglyph.query", () => this.evaluateQuery(request, graphId));
  }

  private async evaluateQuery(request: Request, graphId: GraphId): Promise<Response> {
    const raw = await readJsonBody(request, 16_384);
    if (!raw.ok) return jsonResponse({ error: raw.error.message }, 400);
    const body = requestObject(raw.value);
    if (!body.ok || typeof body.value["query"] !== "string") {
      return jsonResponse({ error: body.ok ? "query must be a string" : body.error.message }, 400);
    }
    const query = parseDatalogQuery(body.value["query"]);
    if (!query.ok) return jsonResponse({ error: query.error.message, offset: query.error.offset }, 400);

    const started = Date.now();
    const cut = await tracing.enterSpan("poneglyph.query.snapshot", () => this.acquireQueryReadCut(graphId, query.value));
    const snapshotMs = Date.now() - started;
    const lease = { snapshotSeq: Math.max(...cut.map(s => s.snapshotSeq)), directoryEpoch: 0,
      expiresAtMs: Math.min(...cut.map(s => s.expiresAtMs)) };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("query time budget exceeded", "TimeoutError")), QUERY_TIMEOUT_MS);
    const source = new DistributedFactSource(this.env, graphId, lease.snapshotSeq, lease.directoryEpoch, lease.expiresAtMs, undefined, cut);
    source.metrics.treeReadLeaseAcquisitions = cut.length;
    const rows: Record<string, unknown>[] = [];
    let evaluationMs = 0, releaseMs = 0;
    try {
      const evaluationStarted = Date.now();
      await tracing.enterSpan("poneglyph.query.evaluate", async () => {
        let responseBytes = 0;
        for await (const binding of evaluateDatalog(query.value, source, {
          maxResults: MAX_QUERY_RESULTS,
          signal: controller.signal,
        })) {
          const row = Object.fromEntries(binding.entries());
          responseBytes += new TextEncoder().encode(JSON.stringify(row)).byteLength + 1;
          if (responseBytes > MAX_QUERY_RESPONSE_BYTES) throw new CoordinatorError(413, "query response byte budget exceeded");
          rows.push(row);
        }
      });
      evaluationMs = Date.now() - evaluationStarted;
    } catch (error) {
      const status = error instanceof QueryResultLimitExceeded || error instanceof QueryScanBudgetExceeded
        ? 413
        : error instanceof CoordinatorError
          ? error.status
          : controller.signal.aborted
            ? 408
            : 502;
      return jsonResponse({ error: errorMessage(error), snapshotSeq: lease.snapshotSeq }, status);
    } finally {
      clearTimeout(timer);
      const releaseStarted = Date.now();
      await tracing.enterSpan("poneglyph.query.release", () => this.releaseReadCut(graphId, cut));
      releaseMs = Date.now() - releaseStarted;
    }
    source.metrics.timing = {executionMs: Date.now() - started, snapshotMs, evaluationMs, releaseMs};
    tracing.getActiveSpan()?.setAttribute("poneglyph.query.rows", rows.length);
    const serialized = JSON.stringify({
      rows,
      snapshotSeq: lease.snapshotSeq,
      sequenceScope: "subtree-vector",
      snapshotVector: cut.map(s => ({ prefix: s.prefix, sequence: s.snapshotSeq, epoch: s.directoryEpoch })),
      metrics: source.metrics,
    });
    if (new TextEncoder().encode(serialized).byteLength > MAX_QUERY_RESPONSE_BYTES) {
      throw new CoordinatorError(413, "query response byte budget exceeded");
    }
    return jsonStringResponse(serialized);
  }

  private async readEntity(request: Request, graphId: GraphId): Promise<Response> {
    const entity = parseUri(new URL(request.url).searchParams.get("uri"), "uri");
    if (!entity.ok) return jsonResponse({ error: entity.error.message }, 400);
    const key = await virtualKeyForEntity(graphId, entity.value);
    const cut = await this.acquireReadCut(graphId, [treeForKey(key)]);
    const lease = cut[0]!;
    try {
      const route = await resolveEntityLeaf(this.env, graphId, entity.value, lease.directoryEpoch);
      const stub = this.env.GRAPH_SHARDS.getByName(shardObjectName(graphId, route.address.prefix));
      const response = await stub.fetch("https://shard.internal/_entity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          graphId,
          shardPrefix: route.address.prefix,
          shardGeneration: route.address.generation,
          directoryEpoch: lease.directoryEpoch,
          entity: entity.value,
          snapshotSeq: lease.snapshotSeq,
          leaseExpiresAtMs: lease.expiresAtMs,
        }),
      });
      if (response.status === 404) return jsonResponse({ entity: null, snapshotSeq: lease.snapshotSeq });
      if (!response.ok) return jsonResponse({ error: (await response.text()).slice(0, 512) }, 502);
      const projection: unknown = await response.json();
      return jsonResponse({ entity: projection, snapshotSeq: lease.snapshotSeq });
    } finally {
      await this.releaseReadCut(graphId, cut);
    }
  }

  private async acquireQueryReadCut(graphId: GraphId, query: DatalogQuery): Promise<TreeSnapshot[]> {
    // A single positive relation with a literal entity can only read that
    // entity's tree. Joins or unbound entities retain the complete owner vector.
    const clause = query.facts.length === 1 ? query.facts[0] : undefined;
    if (clause?.entity.kind === "constant" && clause.entity.value.type === "string") {
      const entity = parseUri(clause.entity.value.value);
      if (entity.ok) {
        const key = await virtualKeyForEntity(graphId, entity.value);
        return this.acquireReadCut(graphId, [treeForKey(key)]);
      }
    }
    return this.acquireReadCut(graphId);
  }

  private async acquireReadCut(graphId: GraphId, prefixes: readonly VirtualPrefix[] = TREE_PREFIXES): Promise<TreeSnapshot[]> {
    return acquireParallelReadCut(async prefix => {
      const response = await this.env.GRAPH_TREES.getByName(treeCoordinatorName(graphId, prefix)).fetch("https://tree.internal/_tree-read", {
        method: "POST", body: JSON.stringify({ graphId, prefix }),
      });
      if (!response.ok) throw new CoordinatorError(423, "cannot acquire an atomic subtree read cut");
      return parseTreeSnapshot(await response.json(), prefix);
    }, cut => this.releaseReadCut(graphId, cut), prefixes);
  }

  private async releaseReadCut(graphId: GraphId, cut: readonly TreeSnapshot[]): Promise<void> {
    const released = await Promise.allSettled(cut.map(async lease => {
      const response = await this.env.GRAPH_TREES.getByName(treeCoordinatorName(graphId, lease.prefix)).fetch("https://tree.internal/_tree-release-read", {
        method: "POST", body: JSON.stringify({ graphId, prefix: lease.prefix, readId: lease.readId }),
      });
      if (!response.ok) console.warn("subtree read release deferred", lease.prefix);
    }));
    for (const result of released) {
      if (result.status === "rejected") console.warn("subtree read release delivery unknown; lease expiry remains the fence");
    }
  }


}

const OBSERVED_VALUE_TAGS: ReadonlySet<string> = new Set([
  "null", "text", "number", "boolean", "bytes", "reference", "date", "date_time", "list", "map",
]);

function parseGraphRoute(request: Request): Readonly<{ graphId: GraphId; action: "transactions" | "query" | "schema" | "entities" }> | undefined {
  const match = /^\/v1\/graphs\/([a-z0-9-]+)\/(transactions|query|schema|entities)$/.exec(new URL(request.url).pathname);
  if (match === null) return undefined;
  const graphId = parseGraphId(match[1]);
  if (!graphId.ok) return undefined;
  const action = match[2];
  if (action !== "transactions" && action !== "query" && action !== "schema" && action !== "entities") return undefined;
  return { graphId: graphId.value, action };
}

class CoordinatorError extends Error {
  constructor(readonly status: number, message: string, readonly retryable = status === 423 || status === 429 || status >= 500) {
    super(message);
    this.name = "CoordinatorError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
