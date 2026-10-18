import { parseDatalogValue, type DatalogValue } from "./datalog/value.js";
import { parseDatalogQuery } from "./datalog/parser.js";
import { parseFactBatch } from "./domain/fact.js";
import type { FactValue } from "./domain/fact-value.js";
import { parseGraphId, type GraphId } from "./domain/graph-id.js";
import { isRecord, type ParseError } from "./domain/result.js";
import { parseClientRequestToken, parseTransactionId, type TransactionId } from "./domain/identifiers.js";
import type { QueryTiming } from "./domain/query-timing.js";
import { parseGraphSchemaObservation, type GraphSchemaObservation } from "./domain/schema-observation.js";
export type { QueryTiming } from "./domain/query-timing.js";
export type { GraphSchemaObservation, ObservedField, ObservedValueTag, SchemaSnapshotOwner } from "./domain/schema-observation.js";

export type FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type DatabaseConfig = Readonly<{
  url: string | URL;
  graphId?: string;
  headers?: HeadersInit;
  fetch?: FetchFunction;
}>;

export type GraphDefinition = Readonly<{ id: string }>;

export type FactInput = Readonly<{
  source: string;
  entity: string;
  field: string;
  value: FactValue;
  retraction?: boolean;
}>;

export type TransactionOptions = Readonly<{
  clientRequestToken?: string;
  signal?: AbortSignal;
}>;

export type QueryOptions = Readonly<{ signal?: AbortSignal }>;

export type TransactionReceipt = Readonly<{ txId: TransactionId }>;

export type QueryMetrics = Readonly<{
  scanCalls: number;
  shardRequests: number;
  distinctShardsTouched?: number;
  treeReadLeaseAcquisitions?: number;
  tuplesRead: number;
  bytesRead: number;
  directoryRequests: number;
  cacheHits?: number;
  timing?: QueryTiming;
}>;

export type QueryBinding = Readonly<Record<string, DatalogValue>>;

export type QueryResult = Readonly<{
  rows: readonly QueryBinding[];
  snapshotSeq: number;
  metrics: QueryMetrics;
}>;

export interface GraphClient {
  readonly id: GraphId;
  transact(facts: readonly FactInput[], options?: TransactionOptions): Promise<TransactionReceipt>;
  query(source: string, options?: QueryOptions): Promise<QueryResult>;
  getSchema(options?: QueryOptions): Promise<GraphSchemaObservation>;
}

export interface DatabaseClient {
  defineGraph(definition: GraphDefinition): GraphClient;
}

export interface DatabaseWithDefaultGraph extends DatabaseClient, GraphClient {}

export class PoneglyphInputError extends TypeError {
  readonly path?: string;
  readonly offset?: number;

  constructor(message: string, parseError?: ParseError) {
    super(message);
    this.name = "PoneglyphInputError";
    if (parseError !== undefined) {
      this.path = parseError.path;
      if (parseError.offset !== undefined) this.offset = parseError.offset;
    }
  }
}

export class PoneglyphNetworkError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "PoneglyphNetworkError";
  }
}

export class PoneglyphRequestError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfter?: string;

  constructor(input: Readonly<{
    status: number;
    message: string;
    retryable: boolean;
    retryAfter?: string;
  }>) {
    super(input.message);
    this.name = "PoneglyphRequestError";
    this.status = input.status;
    this.retryable = input.retryable;
    if (input.retryAfter !== undefined) this.retryAfter = input.retryAfter;
  }
}

export class PoneglyphProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoneglyphProtocolError";
  }
}

export function createDatabase(config: DatabaseConfig & { graphId: string }): DatabaseWithDefaultGraph;
export function createDatabase(config: DatabaseConfig & { graphId?: undefined }): DatabaseClient;
export function createDatabase(config: DatabaseConfig): DatabaseClient | DatabaseWithDefaultGraph {
  if (typeof config !== "object" || config === null) {
    throw new TypeError("Poneglyph config must be an object");
  }
  const transport = new HttpTransport(config);
  const database = new Database(transport);

  if (config.graphId === undefined) return database;

  const graph = database.defineGraph({ id: config.graphId });
  return new DatabaseWithGraph(transport, graph);
}

class Database implements DatabaseClient {
  constructor(private readonly transport: HttpTransport) {}

  defineGraph(definition: GraphDefinition): GraphClient {
    const graphId = parseGraphId(definition?.id, "graph.id");
    if (!graphId.ok) throw new PoneglyphInputError(graphId.error.message, graphId.error);
    return new HttpGraphClient(this.transport, graphId.value);
  }
}

class DatabaseWithGraph extends Database implements DatabaseWithDefaultGraph {
  constructor(transport: HttpTransport, private readonly defaultGraph: GraphClient) {
    super(transport);
    this.id = defaultGraph.id;
  }

  readonly id: GraphId;

  transact(facts: readonly FactInput[], options?: TransactionOptions): Promise<TransactionReceipt> {
    return this.defaultGraph.transact(facts, options);
  }

  query(source: string, options?: QueryOptions): Promise<QueryResult> {
    return this.defaultGraph.query(source, options);
  }

  getSchema(options?: QueryOptions): Promise<GraphSchemaObservation> {
    return this.defaultGraph.getSchema(options);
  }
}

class HttpGraphClient implements GraphClient {
  constructor(
    private readonly transport: HttpTransport,
    readonly id: GraphId,
  ) {}

  async transact(facts: readonly FactInput[], options: TransactionOptions = {}): Promise<TransactionReceipt> {
    const normalizedFacts = normalizeFacts(facts);
    const batch = parseFactBatch({ txId: "poneglyph:validation:client-request", facts: normalizedFacts });
    if (!batch.ok) throw new PoneglyphInputError(batch.error.message, batch.error);

    const token = options.clientRequestToken === undefined
      ? undefined
      : parseClientRequestToken(options.clientRequestToken);
    if (token !== undefined && !token.ok) throw new PoneglyphInputError(token.error.message, token.error);

    const body = {
      facts: batch.value.facts,
      ...(token === undefined ? {} : { clientRequestToken: token.value }),
    };
    const response = await this.transport.post(graphPath(this.id, "transactions"), body, options.signal);
    return parseTransactionReceipt(response);
  }

  async getSchema(options: QueryOptions = {}): Promise<GraphSchemaObservation> {
    const response = await this.transport.post(graphPath(this.id, "schema"), {}, options.signal);
    const schema = parseGraphSchemaObservation(response);
    if (!schema.ok) throw new PoneglyphProtocolError("Poneglyph Worker returned an invalid graph schema observation");
    return schema.value;
  }

  async query(source: string, options: QueryOptions = {}): Promise<QueryResult> {
    if (typeof source !== "string") throw new PoneglyphInputError("query must be a Datalog string");
    const parsedQuery = parseDatalogQuery(source);
    if (!parsedQuery.ok) throw new PoneglyphInputError(parsedQuery.error.message, parsedQuery.error);

    const response = await this.transport.post(
      graphPath(this.id, "query"),
      { query: source },
      options.signal,
    );
    return parseQueryResult(response);
  }
}

class HttpTransport {
  private readonly origin: string;
  private readonly pathPrefix: string;
  private readonly headers: Headers;
  private readonly fetcher: FetchFunction;

  constructor(config: DatabaseConfig) {
    const baseUrl = parseBaseUrl(config.url);
    this.origin = baseUrl.origin;
    this.pathPrefix = baseUrl.pathname.replace(/\/+$/, "");
    this.headers = parseHeaders(config.headers);
    const fetcher = config.fetch ?? globalThis.fetch;
    if (typeof fetcher !== "function") {
      throw new TypeError("Poneglyph requires a fetch implementation");
    }
    this.fetcher = fetcher;
  }

  async post(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const headers = new Headers(this.headers);
    headers.set("content-type", "application/json");
    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    };
    if (signal !== undefined) init.signal = signal;

    let response: Response;
    try {
      response = await this.fetcher(`${this.origin}${this.pathPrefix}${path}`, init);
    } catch (cause) {
      throw new PoneglyphNetworkError("Poneglyph request could not reach the Worker", cause);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      throw new PoneglyphNetworkError("Poneglyph response could not be read", cause);
    }
    let bodyValue: unknown;
    try {
      bodyValue = JSON.parse(text) as unknown;
    } catch {
      if (response.ok) throw new PoneglyphProtocolError("Poneglyph Worker returned invalid JSON");
      bodyValue = { error: text.slice(0, 512) };
    }

    if (!response.ok) {
      const message = isRecord(bodyValue) && typeof bodyValue["error"] === "string"
        ? bodyValue["error"]
        : `Poneglyph request failed with HTTP ${response.status}`;
      const retryAfter = response.headers.get("retry-after") ?? undefined;
      throw new PoneglyphRequestError({
        status: response.status,
        message,
        retryable: isRecord(bodyValue) && typeof bodyValue["retryable"] === "boolean"
          ? bodyValue["retryable"]
          : isRetryableStatus(response.status),
        ...(retryAfter === undefined ? {} : { retryAfter }),
      });
    }

    if (!isRecord(bodyValue)) throw new PoneglyphProtocolError("Poneglyph Worker returned a non-object response");
    return bodyValue;
  }
}

function normalizeFacts(facts: readonly FactInput[]): readonly unknown[] {
  if (!Array.isArray(facts)) throw new PoneglyphInputError("facts must be an array");
  return facts.map((fact) => {
    if (!isRecord(fact)) return fact;
    return { ...fact, retraction: fact["retraction"] ?? false };
  });
}

function graphPath(graphId: GraphId, action: "transactions" | "query" | "schema"): string {
  return `/v1/graphs/${encodeURIComponent(graphId)}/${action}`;
}

function parseBaseUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(input instanceof URL ? input.href : input);
  } catch {
    throw new TypeError("Poneglyph config.url must be an absolute HTTP or HTTPS URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Poneglyph config.url must use HTTP or HTTPS");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new TypeError("Poneglyph config.url cannot contain credentials, a query, or a fragment");
  }
  return url;
}

function parseHeaders(input: HeadersInit | undefined): Headers {
  try {
    return new Headers(input);
  } catch (cause) {
    throw new TypeError("Poneglyph config.headers must contain valid HTTP headers", { cause });
  }
}

function parseTransactionReceipt(input: Record<string, unknown>): TransactionReceipt {
  const txId = parseTransactionId(input["txId"], "receipt.txId");
  if (!txId.ok) throw new PoneglyphProtocolError("Poneglyph Worker returned an invalid transaction receipt");
  return Object.freeze({ txId: txId.value });
}

function parseQueryResult(input: Record<string, unknown>): QueryResult {
  const snapshotSeq = input["snapshotSeq"];
  if (typeof snapshotSeq !== "number" || !Number.isSafeInteger(snapshotSeq) || snapshotSeq < 0) {
    throw new PoneglyphProtocolError("Poneglyph Worker returned an invalid query snapshot sequence");
  }
  const rows = input["rows"];
  if (!Array.isArray(rows)) throw new PoneglyphProtocolError("Poneglyph Worker returned invalid query rows");
  const metrics = parseQueryMetrics(input["metrics"]);
  return Object.freeze({
    rows: Object.freeze(rows.map((row, index) => parseQueryBinding(row, index))),
    snapshotSeq,
    metrics,
  });
}

function parseQueryBinding(input: unknown, index: number): QueryBinding {
  if (!isRecord(input)) throw new PoneglyphProtocolError(`Poneglyph query row ${index} is not an object`);
  const binding: Record<string, DatalogValue> = Object.create(null) as Record<string, DatalogValue>;
  for (const [variable, value] of Object.entries(input)) {
    const parsedValue = parseDatalogValue(value, `rows[${index}].${variable}`);
    if (!parsedValue.ok) {
      throw new PoneglyphProtocolError(`Poneglyph query row ${index} contains an invalid binding for ${variable}`);
    }
    binding[variable] = parsedValue.value;
  }
  return Object.freeze(binding);
}

function parseQueryMetrics(input: unknown): QueryMetrics {
  if (!isRecord(input)) throw new PoneglyphProtocolError("Poneglyph Worker returned invalid query metrics");
  return Object.freeze({
    scanCalls: readMetric(input, "scanCalls"),
    shardRequests: readMetric(input, "shardRequests"),
    ...(input["distinctShardsTouched"] === undefined ? {} : {distinctShardsTouched: readMetric(input, "distinctShardsTouched")}),
    ...(input["treeReadLeaseAcquisitions"] === undefined ? {} : {treeReadLeaseAcquisitions: readMetric(input, "treeReadLeaseAcquisitions")}),
    tuplesRead: readMetric(input, "tuplesRead"),
    bytesRead: readMetric(input, "bytesRead"),
    directoryRequests: readMetric(input, "directoryRequests"),
    ...(input["cacheHits"] === undefined ? {} : {cacheHits: readMetric(input, "cacheHits")}),
    ...(input["timing"] === undefined ? {} : {timing: parseQueryTiming(input["timing"])}),
  });
}

function parseQueryTiming(input: unknown): QueryTiming {
  if (!isRecord(input)) throw new PoneglyphProtocolError("Poneglyph Worker returned invalid query timing");
  const timing = {
    executionMs: readMetric(input, "executionMs"),
    snapshotMs: readMetric(input, "snapshotMs"),
    evaluationMs: readMetric(input, "evaluationMs"),
    releaseMs: readMetric(input, "releaseMs"),
  };
  if (timing.executionMs < timing.snapshotMs + timing.evaluationMs + timing.releaseMs) {
    throw new PoneglyphProtocolError("Poneglyph Worker returned inconsistent query timing");
  }
  return Object.freeze(timing);
}

function readMetric(input: Record<string, unknown>, name: string): number {
  const value = input[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PoneglyphProtocolError(`Poneglyph Worker returned invalid query metric ${name}`);
  }
  return value;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 423 || status === 429 || status >= 500;
}
