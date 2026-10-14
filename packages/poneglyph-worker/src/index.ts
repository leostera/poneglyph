import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import {
  createDatabase, parseTransactionId, PoneglyphInputError, PoneglyphNetworkError,
  PoneglyphProtocolError, PoneglyphRequestError, type FactInput, type GraphClient,
  type GraphId, type TransactionReceipt,
} from "@leostera/poneglyph";
import type { InferEnv } from "cf/config";
import type { serviceWorker } from "../cloudflare.config.ts";
import { dispatchGraphRequest } from "../../poneglyph/src/storage/implementation.js";
import type { StorageEnv } from "../../poneglyph/src/storage/environment.js";
import { authorizeGraph, GraphAuthorizationError, parseGraphRequest, parseIdentity, staticAuthorizer } from "./authorization.js";

export { GraphCoordinatorDO, GraphShardDO } from "../../poneglyph/src/storage/implementation.js";
export { staticAuthorizer, type GraphAuthorizer, type GraphGrants } from "./authorization.js";
export type GraphWriteOptions = Readonly<{ txId: string }>;
type ServiceEnv = InferEnv<{ env: typeof serviceWorker.env }>;

// Only safe, small serializable public error fields cross RPC. In particular,
// never serialize backend causes/stacks. Disconnection still means unknown
// write delivery: callers retain their required original transaction identity.
async function runGraphOperation<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof PoneglyphInputError) throw new PoneglyphInputError(error.message);
    if (error instanceof PoneglyphRequestError) throw new PoneglyphRequestError({
      status: error.status, retryable: error.retryable,
      message: error.status < 500 ? error.message : "Graph operation failed; write delivery may be unknown",
      ...(error.txId === undefined ? {} : { txId: error.txId }),
      ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
    });
    if (error instanceof PoneglyphProtocolError) throw new PoneglyphProtocolError("Graph did not return a valid complete answer; write delivery may be unknown", error.txId);
    if (error instanceof PoneglyphNetworkError) throw new PoneglyphNetworkError("Graph delivery is unavailable; write outcome may be unknown", undefined, error.txId);
    throw new Error("Graph operation failed; write delivery may be unknown");
  }
}
function bindGraph(env: StorageEnv, graphId: GraphId): GraphClient {
  // One canonical dispatcher and public client parser, not a second RPC database
  // implementation. This is an in-process adapter, never public network fetch.
  return createDatabase({ url: "https://poneglyph.internal", graphId,
    fetch: (input, init) => dispatchGraphRequest(new Request(input, init), env, graphId),
  });
}

function parseWriteOptions(input: unknown): GraphWriteOptions {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new PoneglyphInputError("RPC writes require { txId }");
  if (!("txId" in input) || !Object.hasOwn(input, "txId") || Object.keys(input).some(key => key !== "txId")) {
    throw new PoneglyphInputError("RPC writes require { txId } and do not accept transport signals");
  }
  const txId = parseTransactionId(input.txId, "options.txId");
  if (!txId.ok) throw new PoneglyphInputError(txId.error.message, txId.error);
  return Object.freeze({ txId: txId.value });
}

export class ReadGraph extends RpcTarget {
  #graph: GraphClient;
  constructor(graph: GraphClient) { super(); this.#graph = graph; }
  get id(): GraphId { return this.#graph.id; }
  query(source: string) {
    return runGraphOperation(async () => {
      const result = await this.#graph.query(source);
      // Client bindings deliberately have a null prototype. Workers RPC rejects
      // those objects; copy records without changing tagged values/multiplicity.
      return { rows: result.rows.map(row => ({ ...row })), snapshotSeq: result.snapshotSeq, metrics: { ...result.metrics } };
    });
  }
  // Stable API shape, but no write implementation/capability on a read handle.
  async transact(_facts: readonly FactInput[], _options: GraphWriteOptions): Promise<TransactionReceipt> { throw new GraphAuthorizationError(); }
  async stateFacts(facts: readonly FactInput[], options: GraphWriteOptions) { return (await this.transact(facts, options)).txId; }
  state(facts: readonly FactInput[], options: GraphWriteOptions) { return this.stateFacts(facts, options); }
}
export class ReadWriteGraph extends ReadGraph {
  #graph: GraphClient;
  constructor(graph: GraphClient) { super(graph); this.#graph = graph; }
  transact(facts: readonly FactInput[], options: GraphWriteOptions) {
    // A server-minted ID could disappear with a lost RPC reply. Never admit a
    // write for which the caller cannot reconcile the original exact identity.
    const parsed = parseWriteOptions(options);
    return runGraphOperation(() => this.#graph.transact(facts, parsed));
  }
}

export default class PoneglyphService extends WorkerEntrypoint<ServiceEnv> {
  async getGraph(input: { graphId: string }): Promise<ReadGraph> {
    const identity = parseIdentity(this.ctx.props);
    const request = parseGraphRequest(input);
    const authorizer = staticAuthorizer(this.env.GRAPH_GRANTS);
    const permissions = await authorizeGraph(authorizer, identity, request);
    // Acquiring a capability creates no durable objects or graph data.
    const graph = bindGraph(this.env, request.graphId);
    return permissions.includes("write") ? new ReadWriteGraph(graph) : new ReadGraph(graph);
  }
  async fetch(): Promise<Response> { return new Response("Not found", { status: 404 }); }
}
