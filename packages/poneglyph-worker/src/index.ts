import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import {
  createDatabase, PoneglyphInputError, PoneglyphNetworkError,
  PoneglyphProtocolError, PoneglyphRequestError, type FactInput, type GraphClient,
  type GraphId, type TransactionOptions, type TransactionReceipt, type GraphSchemaObservation, parseClientRequestToken,
} from "@leostera/poneglyph";
import type { InferEnv } from "cf/config";
import type { serviceWorker } from "../cloudflare.config.ts";
import { dispatchGraphRequest } from "../../poneglyph/src/storage/implementation.js";
import { dispatchInternalTransaction, dispatchPublicTransaction } from "../../poneglyph/src/storage/transaction-request.js";
import { parseFactBatch } from "../../poneglyph/src/domain/fact.js";
import { parseTransactionId } from "../../poneglyph/src/domain/identifiers.js";
import { executeWorkerQuery } from "./query-coordinator.js";
import type { StorageEnv } from "../../poneglyph/src/storage/environment.js";
import { authorizeGraph, GraphAuthorizationError, parseGraphRequest, parseIdentity, staticAuthorizer } from "./authorization.js";

export { GraphCoordinatorDO, GraphLedgerDO, GraphTreeDO, GraphShardDO } from "../../poneglyph/src/storage/implementation.js";
export { staticAuthorizer, type GraphAuthorizer, type GraphGrants } from "./authorization.js";
export type GraphWriteOptions = Readonly<{ clientRequestToken?: string }>;
export type GraphTransactionRequest = Readonly<{
  graphId: string;
  facts: readonly FactInput[];
  clientRequestToken?: string;
}>;
export type ApprovedBatchReceipt = Readonly<{txId: string; commitSeq: number; status: "committed"}>;
type ServiceEnv = InferEnv<{ env: typeof serviceWorker.env }>;

// Only safe, small serializable public error fields cross RPC. In particular,
// never serialize backend causes/stacks. Disconnection still means unknown
// write delivery: callers may only safely replay with the same request token/facts.
async function runGraphOperation<T>(run: () => Promise<T>, operation: "read" | "write" = "read"): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof PoneglyphInputError) throw new PoneglyphInputError(error.message);
    if (error instanceof PoneglyphRequestError) throw new PoneglyphRequestError({
      status: error.status, retryable: error.retryable,
      message: error.status < 500 ? error.message : operation === "write"
        ? "Graph write failed; delivery may be unknown"
        : "Graph read failed; a complete answer is unavailable",
      ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
    });
    if (error instanceof PoneglyphProtocolError) throw new PoneglyphProtocolError(operation === "write"
      ? "Graph write did not return a valid receipt; delivery may be unknown"
      : "Graph did not return a valid complete read answer");
    if (error instanceof PoneglyphNetworkError) throw new PoneglyphNetworkError(operation === "write"
      ? "Graph delivery is unavailable; write outcome may be unknown"
      : "Graph read is unavailable", undefined);
    throw new Error(operation === "write" ? "Graph write failed; delivery may be unknown" : "Graph read failed; a complete answer is unavailable");
  }
}
function bindGraph(env: StorageEnv, graphId: GraphId): GraphClient {
  // Keep the public parser and canonical ledger protocol. Admission needs no
  // graph-wide actor; publication still MUST reach the canonical facade before
  // the ledger can acknowledge. No stubs or request-owned I/O outlive this call.
  return createDatabase({ url: "https://poneglyph.internal", graphId,
    fetch: (input, init) => {
      const request = new Request(input, init);
      if (request.method === "POST" && new URL(request.url).pathname === `/v1/graphs/${graphId}/transactions`) {
        return dispatchPublicTransaction(request, env, graphId);
      }
      return dispatchGraphRequest(request, env, graphId);
    },
  });
}

function parseWriteOptions(input: unknown): GraphWriteOptions {
  if (typeof input !== "object" || input === null || Array.isArray(input) ||
      Object.keys(input).some(key => key !== "clientRequestToken")) {
    throw new PoneglyphInputError("RPC writes accept only an optional clientRequestToken");
  }
  const token = "clientRequestToken" in input && input.clientRequestToken !== undefined
    ? parseClientRequestToken(input.clientRequestToken)
    : undefined;
  if (token !== undefined && !token.ok) throw new PoneglyphInputError(token.error.message, token.error);
  return Object.freeze(token === undefined ? {} : {clientRequestToken: token.value});
}

export class ReadGraph extends RpcTarget {
  #graph: GraphClient;
  #env: StorageEnv;
  constructor(graph: GraphClient, env: StorageEnv) { super(); this.#graph = graph; this.#env = env; }
  get id(): GraphId { return this.#graph.id; }
  query(source: string) {
    return runGraphOperation(async () => {
      const result = await executeWorkerQuery(this.#env, this.#graph.id, source);
      return { rows: result.rows.map(row => ({ ...row })), snapshotSeq: result.snapshotSeq, metrics: { ...result.metrics } };
    });
  }
  getSchema(): Promise<GraphSchemaObservation> {
    return runGraphOperation(() => this.#graph.getSchema());
  }
  // Stable API shape, but no write implementation/capability on a read handle.
  async transact(_facts: readonly FactInput[], _options?: GraphWriteOptions): Promise<TransactionReceipt> { throw new GraphAuthorizationError(); }
  async transactApprovedBatch(_facts: readonly FactInput[], _options: Readonly<{txId: string}>): Promise<ApprovedBatchReceipt> {
    throw new GraphAuthorizationError();
  }
}
export class ReadWriteGraph extends ReadGraph {
  #graph: GraphClient;
  #env: StorageEnv;
  constructor(graph: GraphClient, env: StorageEnv) { super(graph, env); this.#graph = graph; this.#env = env; }
  transact(facts: readonly FactInput[], options: GraphWriteOptions = {}) {
    const parsed = parseWriteOptions(options);
    return runGraphOperation(() => this.#graph.transact(facts, parsed), "write");
  }
  transactApprovedBatch(facts: readonly FactInput[], options: Readonly<{txId: string}>): Promise<ApprovedBatchReceipt> {
    const txId = parseTransactionId(options?.txId, "options.txId");
    if (!txId.ok) throw new PoneglyphInputError(txId.error.message, txId.error);
    const batch = parseFactBatch({
      txId: txId.value,
      facts: facts.map(fact => ({...fact, retraction: fact.retraction ?? false})),
    });
    if (!batch.ok) throw new PoneglyphInputError(batch.error.message, batch.error);
    return runGraphOperation(async () => {
      const response = await dispatchInternalTransaction(this.#env, this.#graph.id, batch.value);
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
          ? body.error : "Approved transaction was not acknowledged";
        throw new PoneglyphRequestError({status: response.status, message, retryable: response.status >= 500});
      }
      if (typeof body !== "object" || body === null || !("txId" in body) || body.txId !== txId.value ||
          !("status" in body) || body.status !== "committed" || !("commitSeq" in body) ||
          typeof body.commitSeq !== "number" || !Number.isSafeInteger(body.commitSeq) || body.commitSeq < 1) {
        throw new PoneglyphProtocolError("Approved transaction returned an invalid internal receipt");
      }
      return {txId: txId.value, commitSeq: body.commitSeq, status: "committed"};
    }, "write");
  }
}

export default class PoneglyphService extends WorkerEntrypoint<ServiceEnv> {
  // A top-level RPC returning only data has its own execution context. Calls on
  // one long-lived RpcTarget instead share the getGraph invocation's budgets.
  // Authorize every one-shot call; this is not a caller-supplied capability.
  async query(input: {graphId: string; query: string}) {
    const identity = parseIdentity(this.ctx.props);
    if (typeof input !== "object" || input === null || Array.isArray(input) ||
        Object.keys(input).some(key => key !== "graphId" && key !== "query") || typeof input.query !== "string") {
      throw new PoneglyphInputError("query requires a graphId and Datalog string");
    }
    const request = parseGraphRequest({graphId: input.graphId});
    await authorizeGraph(staticAuthorizer(this.env.GRAPH_GRANTS), identity, request);
    return runGraphOperation(() => executeWorkerQuery(this.env, request.graphId, input.query));
  }

  async transact(input: GraphTransactionRequest): Promise<TransactionReceipt> {
    const identity = parseIdentity(this.ctx.props);
    if (typeof input !== "object" || input === null || Array.isArray(input) ||
        !Object.hasOwn(input, "graphId") || !Object.hasOwn(input, "facts") ||
        Object.keys(input).some(key => key !== "graphId" && key !== "facts" && key !== "clientRequestToken")) {
      throw new PoneglyphInputError("transact requires graphId, facts, and an optional clientRequestToken");
    }
    const request = parseGraphRequest({graphId: input.graphId});
    const permissions = await authorizeGraph(staticAuthorizer(this.env.GRAPH_GRANTS), identity, request);
    // Deny before parsing facts/options or touching any storage binding.
    if (!permissions.includes("write")) throw new GraphAuthorizationError();
    const options = parseWriteOptions(Object.hasOwn(input, "clientRequestToken")
      ? {clientRequestToken: input.clientRequestToken} : {});
    return runGraphOperation(() => bindGraph(this.env, request.graphId).transact(input.facts, options), "write");
  }

  async getGraph(input: { graphId: string }): Promise<ReadGraph> {
    const identity = parseIdentity(this.ctx.props);
    const request = parseGraphRequest(input);
    const authorizer = staticAuthorizer(this.env.GRAPH_GRANTS);
    const permissions = await authorizeGraph(authorizer, identity, request);
    // Acquiring a capability creates no durable objects or graph data.
    const graph = bindGraph(this.env, request.graphId);
    return permissions.includes("write") ? new ReadWriteGraph(graph, this.env) : new ReadGraph(graph, this.env);
  }
  async fetch(): Promise<Response> { return new Response("Not found", { status: 404 }); }
}
