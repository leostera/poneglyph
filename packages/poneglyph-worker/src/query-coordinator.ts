import { tracing } from "cloudflare:workers";
import {
  PoneglyphInputError,
  PoneglyphNetworkError,
  PoneglyphProtocolError,
  PoneglyphRequestError,
  type QueryResult,
} from "@leostera/poneglyph";
import { evaluateDatalog, QueryResultLimitExceeded } from "../../poneglyph/src/datalog/evaluator.js";
import { parseDatalogQuery } from "../../poneglyph/src/datalog/parser.js";
import type { DatalogValue } from "../../poneglyph/src/datalog/value.js";
import { parseGraphId, type GraphId } from "../../poneglyph/src/domain/graph-id.js";
import { QueryScanBudgetExceeded } from "../../poneglyph/src/datalog/scan-stream.js";
import type { StorageEnv } from "../../poneglyph/src/storage/environment.js";
import { coordinatorObjectName, parseVirtualPrefix, type VirtualPrefix } from "../../poneglyph/src/storage/keys.js";
import { DistributedFactSource } from "../../poneglyph/src/storage/distributed-fact-source.js";
import { parseTreeSnapshot, TREE_PREFIXES, type TreeSnapshot } from "../../poneglyph/src/storage/forest.js";
import { queryReadPrefixes, releaseParallelReadCut } from "../../poneglyph/src/storage/read-cut.js";
import {
  MAX_QUERY_RESPONSE_BYTES,
  MAX_QUERY_RESULTS,
  QUERY_TIMEOUT_MS,
} from "../../poneglyph/src/storage/constants.js";
import { isRecord } from "../../poneglyph/src/domain/result.js";
import { readFailureDiagnostic } from "../../poneglyph/src/storage/read-diagnostics.js";

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
    const {snapshotSeq, cut} = await tracing.enterSpan("poneglyph.query.snapshot", async () => {
      try {
        return await acquireWorkerQueryCut(env, graphId, sourceText, expectedPrefixes);
      } catch (error) {
        console.error(readFailureDiagnostic("snapshot", error instanceof PoneglyphNetworkError ? error.cause : error));
        throw error;
      }
    });
    const snapshotMs = Date.now() - started;
    const leaseExpiresAtMs = Math.min(...cut.map(lease => lease.expiresAtMs));
    const source = new DistributedFactSource(env, graphId, snapshotSeq, 0, leaseExpiresAtMs, undefined, cut);
    source.metrics.treeReadLeaseAcquisitions = cut.length;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("query time budget exceeded", "TimeoutError")), QUERY_TIMEOUT_MS);
    const rows: Record<string, DatalogValue>[] = [];
    let evaluationMs = 0;
    let releaseMs = 0;
    let failed = false;
    let failure: unknown;

    try {
      const evaluationStarted = Date.now();
      await tracing.enterSpan("poneglyph.query.evaluate", async () => {
        let responseBytes = 0;
        for await (const binding of evaluateDatalog(parsedQuery.value, source, {
          maxResults: MAX_QUERY_RESULTS,
          signal: controller.signal,
        })) {
          const row = Object.fromEntries(binding.entries()) as Record<string, DatalogValue>;
          responseBytes += new TextEncoder().encode(JSON.stringify(row)).byteLength + 1;
          if (responseBytes > MAX_QUERY_RESPONSE_BYTES) throw new QueryResponseTooLarge();
          rows.push(row);
        }
      });
      evaluationMs = Date.now() - evaluationStarted;
    } catch (error) {
      const diagnostic = readFailureDiagnostic("evaluation", error);
      tracing.getActiveSpan()?.setAttribute("poneglyph.read.failure.reason", diagnostic.reason);
      console.error(diagnostic);
      failed = true;
      failure = mapQueryFailure(error, controller.signal.aborted);
    } finally {
      clearTimeout(timer);
      const releaseStarted = Date.now();
      await tracing.enterSpan("poneglyph.query.release", () => releaseParallelReadCut(env, graphId, cut));
      releaseMs = Date.now() - releaseStarted;
    }

    if (failed) throw failure;
    source.metrics.timing = {executionMs: Date.now() - started, snapshotMs, evaluationMs, releaseMs};
    const result: QueryResult = {
      rows,
      snapshotSeq,
      metrics: {...source.metrics},
    };
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_QUERY_RESPONSE_BYTES) {
      throw new PoneglyphRequestError({
        status: 413,
        retryable: false,
        message: "query response byte budget exceeded",
      });
    }
    tracing.getActiveSpan()?.setAttribute("poneglyph.query.rows", rows.length);
    return result;
  });
}

async function acquireWorkerQueryCut(
  env: StorageEnv,
  graphId: GraphId,
  query: string,
  expectedPrefixes: readonly VirtualPrefix[],
): Promise<Readonly<{snapshotSeq: number; cut: readonly TreeSnapshot[]}>> {
  let response: Response;
  try {
    response = await env.GRAPH_FACADES.getByName(coordinatorObjectName(graphId)).fetch("https://facade.internal/_query-read-cut", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({graphId, query}),
    });
  } catch (cause) {
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
  const status = error instanceof QueryResultLimitExceeded || error instanceof QueryScanBudgetExceeded || error instanceof QueryResponseTooLarge
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

class QueryResponseTooLarge extends Error {
  constructor() {
    super("query response byte budget exceeded");
  }
}
