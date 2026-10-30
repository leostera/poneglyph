import { tracing } from "cloudflare:workers";
import {
  PoneglyphInputError,
  PoneglyphNetworkError,
  PoneglyphProtocolError,
  PoneglyphRequestError,
  type QueryResult,
} from "@leostera/poneglyph";
import { QueryResultLimitExceeded } from "../../poneglyph/src/datalog/evaluator.js";
import { collectQueryRows, type QueryRows } from "../../poneglyph/src/storage/query-results.js";
import { parseDatalogQuery } from "../../poneglyph/src/datalog/parser.js";
import { parseGraphId, type GraphId } from "../../poneglyph/src/domain/graph-id.js";
import { QueryScanBudgetExceeded } from "../../poneglyph/src/datalog/scan-stream.js";
import type { StorageEnv } from "../../poneglyph/src/storage/environment.js";
import { coordinatorObjectName, parseVirtualPrefix, type VirtualPrefix } from "../../poneglyph/src/storage/keys.js";
import { DistributedFactSource } from "../../poneglyph/src/storage/distributed-fact-source.js";
import { parseTreeSnapshot, TREE_PREFIXES, type TreeSnapshot } from "../../poneglyph/src/storage/forest.js";
import { queryReadPrefixes, releaseParallelReadCut } from "../../poneglyph/src/storage/read-cut.js";
import {
  MAX_QUERY_RESPONSE_BYTES,
  QUERY_TIMEOUT_MS,
} from "../../poneglyph/src/storage/constants.js";
import { isRecord } from "../../poneglyph/src/domain/result.js";
import { readFailureDiagnostic } from "../../poneglyph/src/storage/read-diagnostics.js";
import { BoundedReadCache, utf8Bytes } from "../../poneglyph/src/storage/read-cache.js";
import type { ReadIdentity } from "../../poneglyph/src/storage/read-identity.js";
import { MAX_QUERY_CACHE_BYTES, MAX_QUERY_CACHE_ENTRIES, MAX_QUERY_CACHE_ENTRY_BYTES } from "../../poneglyph/src/storage/constants.js";
import { completedReadHeadRouter } from "./read-head-routing.js";

type CompletedQuery = Readonly<{rowsJson: string; identity: ReadIdentity}>;
// Completed immutable data only: never retain promises, streams, stubs, leases,
// or request-owned I/O in module state. Every reuse requires a fresh facade check.
// Current authorization is graph-wide read access, checked before this executor.
const completedQueries = new BoundedReadCache<CompletedQuery>(MAX_QUERY_CACHE_ENTRIES, MAX_QUERY_CACHE_BYTES);
type WorkerReadCut = Readonly<{snapshotSeq: number; cut: readonly TreeSnapshot[]}> | Readonly<{snapshotSeq: number; unchanged: true}>;

/**
 * Stateless query execution for the Worker RPC surface. The facade remains the
 * authority that captures a safe vector and grants exact tree leases; after
 * that cut is pinned, query planning, shard fan-out, joins, and response
 * assembly run in the horizontally scalable Worker rather than the facade DO.
 */
export async function executeWorkerQuery(
  env: StorageEnv,
  graphIdInput: string,
  sourceText: string,
): Promise<QueryResult> {
  const graph = parseGraphId(graphIdInput);
  if (!graph.ok) throw new PoneglyphInputError(graph.error.message, graph.error);
  const graphId = graph.value;
  if (typeof sourceText !== "string") throw new PoneglyphInputError("query must be a Datalog string");
  const parsedQuery = parseDatalogQuery(sourceText);
  if (!parsedQuery.ok) throw new PoneglyphInputError(parsedQuery.error.message, parsedQuery.error);

  return tracing.enterSpan("poneglyph.query", async () => {
    const started = Date.now();
    const expectedPrefixes = await queryReadPrefixes(graphId, parsedQuery.value);
    const cacheKey = JSON.stringify(["worker-query-v1", "graph-read", graphId, parsedQuery.value]);
    const candidate = completedQueries.get(cacheKey);
    // Adding a cache hint must not make an otherwise valid envelope too large.
    const cached = candidate !== undefined && utf8Bytes(JSON.stringify({graphId, query: sourceText, knownSnapshot: candidate.identity})) <= 16_384
      ? candidate : undefined;
    const acquired = await tracing.enterSpan("poneglyph.query.snapshot", async () => {
      try {
        return await acquireWorkerQueryCut(env, graphId, sourceText, expectedPrefixes, cached?.identity);
      } catch (error) {
        console.error(readFailureDiagnostic("snapshot", error instanceof PoneglyphNetworkError ? error.cause : error));
        throw error;
      }
    });
    const snapshotMs = Date.now() - started;
    if ("unchanged" in acquired) {
      if (cached === undefined) throw new PoneglyphProtocolError("Graph facade validated an unknown cached result");
      // Parse our own completed serialization to give every caller an isolated
      // copy. History retention is irrelevant: no storage is read on this path.
      const rows = JSON.parse(cached.rowsJson) as QueryResult["rows"];
      tracing.getActiveSpan()?.setAttribute("poneglyph.query.cache.hit", true);
      return {rows, snapshotSeq: acquired.snapshotSeq, metrics: {
        scanCalls: 0, shardRequests: 0, distinctShardsTouched: 0, treeReadLeaseAcquisitions: 0,
        tuplesRead: 0, bytesRead: 0, directoryRequests: 0, cacheHits: 1,
        timing: {executionMs: Date.now() - started, snapshotMs, evaluationMs: 0, releaseMs: 0},
      }};
    }
    tracing.getActiveSpan()?.setAttribute("poneglyph.query.cache.hit", false);
    const {snapshotSeq, cut} = acquired;
    const source = new DistributedFactSource(env, graphId, cut);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("query time budget exceeded", "TimeoutError")), QUERY_TIMEOUT_MS);
    let rows: QueryRows;
    let evaluationMs = 0;
    let releaseMs = 0;

    try {
      const evaluationStarted = Date.now();
      rows = await tracing.enterSpan("poneglyph.query.evaluate", () => collectQueryRows(parsedQuery.value, source, controller.signal));
      evaluationMs = Date.now() - evaluationStarted;
    } catch (error) {
      const diagnostic = readFailureDiagnostic("evaluation", error);
      tracing.getActiveSpan()?.setAttribute("poneglyph.read.failure.reason", diagnostic.reason);
      console.error(diagnostic);
      throw mapQueryFailure(error, controller.signal.aborted);
    } finally {
      clearTimeout(timer);
      const releaseStarted = Date.now();
      await tracing.enterSpan("poneglyph.query.release", () => releaseParallelReadCut(env, graphId, cut));
      releaseMs = Date.now() - releaseStarted;
    }

    source.metrics.timing = {executionMs: Date.now() - started, snapshotMs, evaluationMs, releaseMs};
    const result: QueryResult = {
      rows,
      snapshotSeq,
      metrics: {...source.metrics},
    };
    if (utf8Bytes(JSON.stringify(result)) > MAX_QUERY_RESPONSE_BYTES) {
      throw new PoneglyphRequestError({
        status: 413,
        retryable: false,
        message: "query response byte budget exceeded",
      });
    }
    tracing.getActiveSpan()?.setAttribute("poneglyph.query.rows", rows.length);
    const entry: CompletedQuery = {
      rowsJson: JSON.stringify(rows),
      identity: Object.freeze(cut.map(({prefix, snapshotSeq, directoryEpoch}) => Object.freeze({prefix, snapshotSeq, directoryEpoch}))),
    };
    const entryBytes = utf8Bytes(entry.rowsJson) + utf8Bytes(JSON.stringify(entry.identity));
    if (utf8Bytes(cacheKey) + entryBytes <= MAX_QUERY_CACHE_ENTRY_BYTES) completedQueries.set(cacheKey, entry, entryBytes);
    return result;
  });
}

async function acquireWorkerQueryCut(
  env: StorageEnv,
  graphId: GraphId,
  query: string,
  expectedPrefixes: readonly VirtualPrefix[],
  knownSnapshot?: ReadIdentity,
): Promise<WorkerReadCut> {
  if (knownSnapshot !== undefined) {
    const validation = await completedReadHeadRouter.validate(env, graphId, query, knownSnapshot);
    tracing.getActiveSpan()?.setAttribute("poneglyph.query.read_head.hit", validation.kind === "unchanged");
    if (validation.kind === "unchanged") {
      return {unchanged: true, snapshotSeq: Math.max(...knownSnapshot.map(owner => owner.snapshotSeq))};
    }
    tracing.getActiveSpan()?.setAttribute("poneglyph.query.read_head.fallback", validation.reason);
  }
  let response: Response;
  try {
    response = await env.GRAPH_FACADES.getByName(coordinatorObjectName(graphId)).fetch("https://facade.internal/_query-read-cut", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({graphId, query, ...(knownSnapshot === undefined ? {} : {knownSnapshot})}),
    });
  } catch (cause) {
    console.error({event: "candidate-canonical-cut-transport", errorName: cause instanceof Error ? cause.name : "unknown",
      errorMessage: cause instanceof Error ? cause.message.slice(0, 300) : String(cause).slice(0, 300)});
    throw new PoneglyphNetworkError("Graph read is unavailable", cause);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PoneglyphProtocolError("Graph facade returned an invalid read-cut response");
  }
  if (!response.ok) {
    const message = isRecord(body) && typeof body["error"] === "string"
      ? body["error"]
      : "Graph snapshot could not be acquired";
    const retryable = isRecord(body) && typeof body["retryable"] === "boolean"
      ? body["retryable"]
      : response.status === 408 || response.status === 423 || response.status === 429 || response.status >= 500;
    throw new PoneglyphRequestError({status: response.status, message, retryable});
  }
  try {
    if (isRecord(body) && body["unchanged"] === true) {
      if (knownSnapshot === undefined || Object.keys(body).some(key => key !== "unchanged" && key !== "snapshotSeq") ||
          body["snapshotSeq"] !== Math.max(...knownSnapshot.map(owner => owner.snapshotSeq))) {
        throw new PoneglyphProtocolError("Graph facade returned an invalid cache validation");
      }
      return {unchanged: true, snapshotSeq: Math.max(...knownSnapshot.map(owner => owner.snapshotSeq))};
    }
    return parseWorkerQueryCut(body, expectedPrefixes);
  } catch (error) {
    const knownLeases = readKnownLeasesForCleanup(body);
    if (knownLeases.length > 0) await releaseParallelReadCut(env, graphId, knownLeases);
    throw error;
  }
}

function parseWorkerQueryCut(
  input: unknown,
  expectedPrefixes: readonly VirtualPrefix[],
): Readonly<{snapshotSeq: number; cut: readonly TreeSnapshot[]}> {
  if (!isRecord(input) || !isCounter(input["snapshotSeq"]) || !Array.isArray(input["cut"]) ||
      input["cut"].length === 0 || input["cut"].length > TREE_PREFIXES.length) {
    throw new PoneglyphProtocolError("Graph facade returned an invalid read cut");
  }
  const cut: TreeSnapshot[] = [];
  const seen = new Set<string>();
  for (const item of input["cut"]) {
    if (!isRecord(item)) throw new PoneglyphProtocolError("Graph facade returned an invalid tree lease");
    const prefix = parseVirtualPrefix(item["prefix"]);
    if (!prefix.ok || !TREE_PREFIXES.includes(prefix.value) || seen.has(prefix.value)) {
      throw new PoneglyphProtocolError("Graph facade returned an invalid tree lease prefix");
    }
    try {
      cut.push(parseTreeSnapshot(item, prefix.value));
    } catch {
      throw new PoneglyphProtocolError("Graph facade returned an invalid tree lease");
    }
    seen.add(prefix.value);
  }
  if (cut.length !== expectedPrefixes.length || expectedPrefixes.some(prefix => !seen.has(prefix))) {
    throw new PoneglyphProtocolError("Graph facade returned a read cut that does not cover the query owners");
  }
  const snapshotSeq = Math.max(...cut.map(lease => lease.snapshotSeq));
  if (input["snapshotSeq"] !== snapshotSeq) throw new PoneglyphProtocolError("Graph facade returned an inconsistent read cut");
  return {snapshotSeq, cut: Object.freeze(cut)};
}

function readKnownLeasesForCleanup(input: unknown): readonly TreeSnapshot[] {
  if (!isRecord(input) || !Array.isArray(input["cut"]) || input["cut"].length > TREE_PREFIXES.length) return [];
  const leases: TreeSnapshot[] = [];
  const seen = new Set<string>();
  for (const item of input["cut"]) {
    if (!isRecord(item)) continue;
    const prefix = parseVirtualPrefix(item["prefix"]);
    if (!prefix.ok || !TREE_PREFIXES.includes(prefix.value) || seen.has(prefix.value)) continue;
    try {
      leases.push(parseTreeSnapshot(item, prefix.value));
      seen.add(prefix.value);
    } catch {
      // Release only independently validated lease identities; expiry remains
      // the fence for any malformed or otherwise unknown response component.
    }
  }
  return leases;
}

function mapQueryFailure(error: unknown, timedOut: boolean): PoneglyphRequestError {
  if (error instanceof PoneglyphRequestError) return error;
  const status = error instanceof QueryResultLimitExceeded || error instanceof QueryScanBudgetExceeded
    ? 413
    : timedOut
      ? 408
      : 502;
  const message = error instanceof Error ? error.message : "query evaluation failed";
  return new PoneglyphRequestError({status, retryable: status === 408 || status >= 500, message});
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
