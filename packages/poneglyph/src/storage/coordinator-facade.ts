import { DurableObject, tracing } from "cloudflare:workers";
import { acquireParallelReadCut, queryReadPrefixes, releaseParallelReadCut } from "./read-cut.js";
import { parseReadIdentity, readIdentityMatches, type ReadIdentity } from "./read-identity.js";
import type { StorageEnv as Env } from "./environment.js";
import { parseGraphId, type GraphId } from "../domain/graph-id.js";
import { parseUri } from "../domain/identifiers.js";
import { compareUnicodeScalars } from "../domain/string-order.js";
import { isRecord } from "../domain/result.js";
import { evaluateDatalog, QueryResultLimitExceeded } from "../datalog/evaluator.js";
import type { DatalogQuery } from "../datalog/ast.js";
import { parseDatalogQuery } from "../datalog/parser.js";
import { DistributedFactSource, type QueryMetrics } from "./distributed-fact-source.js";
import { BoundedReadCache, utf8Bytes } from "./read-cache.js";
import { QueryScanBudgetExceeded } from "../datalog/scan-stream.js";
import {
  MAX_QUERY_CACHE_BYTES, MAX_QUERY_CACHE_ENTRIES, MAX_QUERY_CACHE_ENTRY_BYTES,
  MAX_QUERY_RESPONSE_BYTES, MAX_QUERY_RESULTS, MAX_QUERY_SHARD_FANOUT, QUERY_TIMEOUT_MS,
} from "./constants.js";
import { jsonResponse, jsonStringResponse, readJsonBody, requestObject } from "./http.js";
import { parseVirtualPrefix, shardObjectName, virtualKeyForEntity, type VirtualPrefix } from "./keys.js";
import { listShardLeaves, resolveEntityLeaf } from "./routing.js";
import { dispatchPublicTransaction } from "./transaction-request.js";
import { ensureFacadeSchema } from "./sql.js";
import { TREE_PREFIXES, TREE_DEPTH, treeCoordinatorName, treeForKey, parseTreeSnapshot, type TreeSnapshot } from "./forest.js";
import { resolveReadHeadReplicaIdentity } from "./read-head-placement.js";
import { ReadHeadReplica } from "./read-head-replica.js";

type SafeVectorRow = Readonly<{prefix: string; directory_epoch: number; visible_seq: number}>;
type SafeFrontierRow = Readonly<{frontier: number}>;
type CachedQueryResult = Readonly<{rowsJson: string; snapshotSeq: number; snapshotVectorJson: string}>;
type SafeSnapshot = Readonly<{frontier: number; vector: readonly SafeVectorRow[]}>;

type FacadeEnv = Env;

/** Graph-facing request surface. Durable state lives in ledgers, trees, and shards. */
export class GraphCoordinatorDO extends DurableObject<FacadeEnv> {
  private readonly queryCache = new BoundedReadCache<CachedQueryResult>(MAX_QUERY_CACHE_ENTRIES, MAX_QUERY_CACHE_BYTES);
  private readonly queryOwnerCache = new BoundedReadCache<readonly VirtualPrefix[]>(MAX_QUERY_CACHE_ENTRIES, MAX_QUERY_CACHE_BYTES);
  private safeSnapshot: Readonly<{graphId: GraphId; snapshot: SafeSnapshot}> | undefined;
  private readHeadReplica: ReadHeadReplica | undefined;

  constructor(ctx: DurableObjectState, env: FacadeEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      ensureFacadeSchema(ctx.storage);
      const replica = resolveReadHeadReplicaIdentity(ctx);
      if (replica !== null) {
        this.readHeadReplica = new ReadHeadReplica(ctx, env, replica);
        return;
      }
      ctx.storage.transactionSync(() => {
        for (const prefix of TREE_PREFIXES) ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO graph_safe_vector (prefix, directory_epoch, visible_seq) VALUES (?, 0, 0)", prefix);
      });
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (this.readHeadReplica !== undefined) return this.readHeadReplica.fetch(request);
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/_publish-vector") return await this.publishSafeVector(request);
    if (request.method === "POST" && path === "/_advance-vector-epoch") return await this.advanceSafeVectorEpoch(request);
    if (request.method === "POST" && path === "/_query-read-cut") return await this.acquireWorkerQueryCut(request);
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

  private async acquireWorkerQueryCut(request: Request): Promise<Response> {
    const raw = await readJsonBody(request, 16_384);
    if (!raw.ok || !isRecord(raw.value) || Object.keys(raw.value).some(key => key !== "graphId" && key !== "query" && key !== "knownSnapshot")) {
      return jsonResponse({error: "invalid query read-cut envelope"}, 400);
    }
    const graph = parseGraphId(raw.value["graphId"]);
    if (!graph.ok || typeof raw.value["query"] !== "string") return jsonResponse({error: "invalid query read-cut identity"}, 400);
    const ownerCacheKey = JSON.stringify([graph.value, raw.value["query"]]);
    let prefixes = this.queryOwnerCache.get(ownerCacheKey);
    if (prefixes === undefined) {
      const query = parseDatalogQuery(raw.value["query"]);
      if (!query.ok) return jsonResponse({error: query.error.message, offset: query.error.offset}, 400);
      prefixes = Object.freeze(await queryReadPrefixes(graph.value, query.value));
      this.queryOwnerCache.set(ownerCacheKey, prefixes, utf8Bytes(JSON.stringify(prefixes)));
    }
    let knownSnapshot: ReadIdentity | undefined;
    if (raw.value["knownSnapshot"] !== undefined) {
      try {
        knownSnapshot = parseReadIdentity(raw.value["knownSnapshot"], prefixes);
      } catch {
        return jsonResponse({error: "invalid known snapshot"}, 400);
      }
    }
    try {
      // Linearization point for both cache validation and ordinary lease reads.
      // Never read owner heads independently to assemble a 'current' vector.
      const safeVector = this.cachedSafeVector(graph.value);
      if (knownSnapshot !== undefined && readIdentityMatches(knownSnapshot, safeVector.vector)) {
        return jsonResponse({unchanged: true, snapshotSeq: Math.max(...knownSnapshot.map(owner => owner.snapshotSeq))});
      }
      const cut = await this.acquireReadCut(graph.value, prefixes, safeVector);
      return jsonResponse({snapshotSeq: Math.max(...cut.map(lease => lease.snapshotSeq)), cut});
    } catch (error) {
      const status = error instanceof CoordinatorError ? error.status : 503;
      return jsonResponse({error: errorMessage(error), retryable: error instanceof CoordinatorError ? error.retryable : true}, status);
    }
  }

  private async publishSafeVector(request: Request): Promise<Response> {
    const raw = await readJsonBody(request, 8_192);
    if (!raw.ok || !isRecord(raw.value) || !Array.isArray(raw.value["owners"])) return jsonResponse({error: "invalid safe-vector publication"}, 400);
    const graph = parseGraphId(raw.value["graphId"]);
    if (!graph.ok || raw.value["owners"].length < 1 || raw.value["owners"].length > TREE_PREFIXES.length)
      return jsonResponse({error: "invalid safe-vector identity"}, 400);
    const owners: {prefix: VirtualPrefix; directoryEpoch: number; publicationSeq: number}[] = [];
    for (const rawOwner of raw.value["owners"]) {
      if (!isRecord(rawOwner)) return jsonResponse({error: "invalid safe-vector owner"}, 400);
      const prefix = parseVirtualPrefix(rawOwner["prefix"]), epoch = rawOwner["directoryEpoch"], seq = rawOwner["publicationSeq"];
      if (!prefix.ok || !TREE_PREFIXES.includes(prefix.value) || !isCounter(epoch) || !isCounter(seq, 1))
        return jsonResponse({error: "invalid safe-vector owner revision"}, 400);
      owners.push({prefix: prefix.value, directoryEpoch: epoch, publicationSeq: seq});
    }
    if (new Set(owners.map(owner => owner.prefix)).size !== owners.length) return jsonResponse({error: "duplicate safe-vector owner"}, 400);
    try {
      const result = this.ctx.storage.transactionSync(() => {
        this.assertFacadeIdentity(graph.value);
        let changed = false;
        for (const owner of owners) {
          const current = this.ctx.storage.sql.exec<SafeVectorRow>("SELECT * FROM graph_safe_vector WHERE prefix = ?", owner.prefix).toArray()[0];
          if (!current || current.directory_epoch !== owner.directoryEpoch || owner.publicationSeq < current.visible_seq)
            throw new CoordinatorError(409, "safe-vector owner epoch or revision regressed");
          if (owner.publicationSeq === current.visible_seq) continue;
          this.ctx.storage.sql.exec("UPDATE graph_safe_vector SET visible_seq = ? WHERE prefix = ?", owner.publicationSeq, owner.prefix);
          changed = true;
        }
        if (changed) this.advanceSafeFrontier();
        return {frontier: this.readSafeFrontier()};
      });
      return jsonResponse(result);
    } catch (error) {
      return jsonResponse({error: errorMessage(error)}, error instanceof CoordinatorError ? error.status : 503);
    }
  }

  private async advanceSafeVectorEpoch(request: Request): Promise<Response> {
    const raw = await readJsonBody(request, 4_096);
    if (!raw.ok || !isRecord(raw.value)) return jsonResponse({error: "invalid safe-vector epoch update"}, 400);
    const graph = parseGraphId(raw.value["graphId"]), prefix = parseVirtualPrefix(raw.value["prefix"]);
    const epoch = raw.value["directoryEpoch"], seq = raw.value["visibleSeq"];
    if (!graph.ok || !prefix.ok || !TREE_PREFIXES.includes(prefix.value) || !isCounter(epoch) || epoch < 1 || !isCounter(seq))
      return jsonResponse({error: "invalid safe-vector epoch identity"}, 400);
    try {
      const result = this.ctx.storage.transactionSync(() => {
        this.assertFacadeIdentity(graph.value);
        const current = this.ctx.storage.sql.exec<SafeVectorRow>("SELECT * FROM graph_safe_vector WHERE prefix = ?", prefix.value).toArray()[0];
        if (!current || epoch < current.directory_epoch || seq < current.visible_seq)
          throw new CoordinatorError(409, "safe-vector topology epoch or revision regressed");
        const changed = epoch !== current.directory_epoch || seq !== current.visible_seq;
        if (changed) {
          this.ctx.storage.sql.exec("UPDATE graph_safe_vector SET directory_epoch = ?, visible_seq = ? WHERE prefix = ?",
            epoch, seq, prefix.value);
          this.advanceSafeFrontier();
        }
        return {frontier: this.readSafeFrontier()};
      });
      return jsonResponse(result);
    } catch (error) {
      return jsonResponse({error: errorMessage(error)}, error instanceof CoordinatorError ? error.status : 503);
    }
  }

  private assertFacadeIdentity(graphId: GraphId): void {
    const identity = this.ctx.storage.sql.exec<{graph_id: string}>("SELECT graph_id FROM graph_facade_identity WHERE singleton = 1").toArray()[0];
    if (identity && identity.graph_id !== graphId) throw new CoordinatorError(409, "facade graph identity mismatch");
    if (!identity) this.ctx.storage.sql.exec("INSERT INTO graph_facade_identity (singleton, graph_id) VALUES (1, ?)", graphId);
  }

  private readSafeFrontier(): number {
    return this.ctx.storage.sql.exec<SafeFrontierRow>("SELECT frontier FROM graph_safe_frontier WHERE singleton = 1").one().frontier;
  }

  private advanceSafeFrontier(): void {
    // Both publication and topology mutation run synchronously in one SQLite
    // transaction. Invalidate before advancing, including on rollback/error.
    // No request can observe an old mirror after a successful durable update.
    this.safeSnapshot = undefined;
    const current = this.readSafeFrontier();
    if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER)
      throw new CoordinatorError(429, "cluster safe frontier space is exhausted");
    this.ctx.storage.sql.exec("UPDATE graph_safe_frontier SET frontier = ? WHERE singleton = 1", current + 1);
  }

  private readSafeVector(): readonly SafeVectorRow[] {
    return this.ctx.storage.sql.exec<SafeVectorRow>("SELECT prefix, directory_epoch, visible_seq FROM graph_safe_vector ORDER BY prefix").toArray();
  }

  private cachedSafeVector(graphId: GraphId): SafeSnapshot {
    if (this.safeSnapshot !== undefined) {
      if (this.safeSnapshot.graphId !== graphId) throw new CoordinatorError(409, "facade graph identity mismatch");
      return this.safeSnapshot.snapshot;
    }
    const snapshot = this.ctx.storage.transactionSync(() => {
      this.assertFacadeIdentity(graphId);
      const vector = this.readSafeVector();
      if (vector.length !== TREE_PREFIXES.length || vector.some((owner, index) =>
          owner.prefix !== TREE_PREFIXES[index] || !isCounter(owner.directory_epoch) || !isCounter(owner.visible_seq)))
        throw new CoordinatorError(503, "cached safe vector is incomplete or corrupt");
      const frontier = this.readSafeFrontier();
      if (!isCounter(frontier)) throw new CoordinatorError(503, "cached safe frontier is corrupt");
      return Object.freeze({frontier, vector: Object.freeze(vector.map(owner => Object.freeze(owner)))});
    });
    // This is a mirror of this actor's durable vector, not an independently
    // assembled owner-head cache. Restarts rebuild it from SQLite.
    this.safeSnapshot = Object.freeze({graphId, snapshot});
    return snapshot;
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
    const safeVector = this.cachedSafeVector(graphId);
    const cacheKey = queryResultCacheKey(graphId, safeVector, query.value);
    const cached = this.queryCache.get(cacheKey);
    if (cached) return this.cachedQueryResponse(cached, started);

    const cut = await tracing.enterSpan("poneglyph.query.snapshot", () => this.acquireQueryReadCut(graphId, query.value, safeVector));
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
    const responseBytes = utf8Bytes(serialized);
    if (responseBytes > MAX_QUERY_RESPONSE_BYTES) {
      throw new CoordinatorError(413, "query response byte budget exceeded");
    }
    const rowsJson = JSON.stringify(rows);
    const snapshotVectorJson = JSON.stringify(cut.map(s => ({prefix: s.prefix, sequence: s.snapshotSeq, epoch: s.directoryEpoch})));
    const cacheBytes = utf8Bytes(rowsJson) + utf8Bytes(snapshotVectorJson);
    if (utf8Bytes(cacheKey) + cacheBytes <= MAX_QUERY_CACHE_ENTRY_BYTES) {
      this.queryCache.set(cacheKey, {rowsJson, snapshotSeq: lease.snapshotSeq, snapshotVectorJson}, cacheBytes);
    }
    return jsonStringResponse(serialized);
  }

  private cachedQueryResponse(entry: CachedQueryResult, started: number): Response {
    const snapshotMs = Date.now() - started;
    const metrics: QueryMetrics = {
      scanCalls: 0,
      shardRequests: 0,
      distinctShardsTouched: 0,
      treeReadLeaseAcquisitions: 0,
      tuplesRead: 0,
      bytesRead: 0,
      directoryRequests: 0,
      cacheHits: 1,
      timing: {executionMs: Date.now() - started, snapshotMs, evaluationMs: 0, releaseMs: 0},
    };
    return jsonStringResponse(`{"rows":${entry.rowsJson},"snapshotSeq":${entry.snapshotSeq},"sequenceScope":"subtree-vector","snapshotVector":${entry.snapshotVectorJson},"metrics":${JSON.stringify(metrics)}}`);
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

  private async acquireQueryReadCut(
    graphId: GraphId,
    query: DatalogQuery,
    safeVector: Readonly<{frontier: number; vector: readonly SafeVectorRow[]}>,
  ): Promise<TreeSnapshot[]> {
    const prefixes = await queryReadPrefixes(graphId, query);
    return this.acquireReadCut(graphId, prefixes, safeVector);
  }

  private async acquireReadCut(
    graphId: GraphId,
    prefixes: readonly VirtualPrefix[] = TREE_PREFIXES,
    safeVector = this.cachedSafeVector(graphId),
  ): Promise<TreeSnapshot[]> {
    const cached = safeVector;
    const cut = await acquireParallelReadCut(async prefix => {
      const owner = cached.vector.find(entry => entry.prefix === prefix);
      if (!owner) throw new CoordinatorError(503, "cached safe vector is missing a selected owner");
      const response = await this.env.GRAPH_TREES.getByName(treeCoordinatorName(graphId, prefix)).fetch("https://tree.internal/_tree-read", {
        method: "POST", body: JSON.stringify({graphId, prefix, snapshotSeq: owner.visible_seq, directoryEpoch: owner.directory_epoch}),
      });
      if (!response.ok) throw new CoordinatorError(423, "cannot acquire an atomic subtree read cut");
      return parseTreeSnapshot(await response.json(), prefix);
    }, leases => this.releaseReadCut(graphId, leases), prefixes);
    try {
      for (const lease of cut) {
        const owner = cached.vector.find(entry => entry.prefix === lease.prefix);
        if (!owner || lease.directoryEpoch !== owner.directory_epoch || lease.snapshotSeq !== owner.visible_seq)
          throw new CoordinatorError(503, "tree lease is behind the durable cluster safe vector");
      }
      return cut;
    } catch (error) {
      await this.releaseReadCut(graphId, cut);
      throw error;
    }
  }

  private async releaseReadCut(graphId: GraphId, cut: readonly TreeSnapshot[]): Promise<void> {
    return releaseParallelReadCut(this.env, graphId, cut);
  }


}

function queryResultCacheKey(
  graphId: GraphId,
  safeVector: Readonly<{frontier: number; vector: readonly SafeVectorRow[]}>,
  query: DatalogQuery,
): string {
  return JSON.stringify(["query-result-v1", graphId, safeVector.frontier,
    safeVector.vector.map(owner => [owner.prefix, owner.directory_epoch, owner.visible_seq]), query]);
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

function isCounter(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
