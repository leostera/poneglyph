import type { FactInput, FactValue, QueryResult, TransactionReceipt } from "@leostera/poneglyph";

// The browser playground's HTTP surface. It owns no storage: reads use the
// read-only service principal, writes use a separate principal granted write on
// exactly one graph. The playground is public: every visitor shares the
// "anonymous" author and is rate limited per edge IP. Caller headers, cookies
// and body fields never select a principal.

export const API_RATE_LIMIT = { namespace: "2026102101", simple: { limit: 120, period: 60 as const } };
export const WRITE_RATE_LIMIT = { namespace: "2026102102", simple: { limit: 20, period: 60 as const } };
export const API_LIMITS = Object.freeze({
  requestBytes: 16_384,
  queryCharacters: 8_192,
  factsPerWrite: 25,
  valueCharacters: 2_000,
  requestTokenCharacters: 64,
});
export const WRITABLE_VALUE_TYPES = ["text", "number", "boolean", "reference", "date", "date_time"] as const;
type WritableValueType = typeof WRITABLE_VALUE_TYPES[number];

interface ReadService {
  query(input: { graphId: string; query: string }): Promise<QueryResult>;
  getGraph(input: { graphId: string }): Promise<SchemaGraph>;
}
interface SchemaGraph extends Disposable { getSchema(): Promise<unknown> }
interface WriteGraph extends Disposable { transact(facts: readonly FactInput[], options: { clientRequestToken: string }): Promise<TransactionReceipt> }
interface WriteService { getGraph(input: { graphId: string }): Promise<WriteGraph> }
type Limiter = Pick<RateLimit, "limit">;

export interface ApiEnv {
  PONEGLYPH?: ReadService;
  PONEGLYPH_WRITER?: WriteService;
  API_RATE_LIMITER?: Limiter;
  WRITE_RATE_LIMITER?: Limiter;
}
export type ApiOptions = Readonly<{
  host: string;
  graphId: string;
  session: Readonly<Record<string, unknown>>;
}>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
type Visitor = Readonly<{ author: string; rateKey: string }>;
export const ANONYMOUS_AUTHOR = "anonymous";
type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}
function fail(status: number, error: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return json({ error, ...extra }, status, headers);
}

export function createApiHandler(options: ApiOptions) {
  return async (request: Request, env: ApiEnv): Promise<Response> => {
    const url = new URL(request.url);
    // Loopback hosts exist only in local previews; the public route is fixed.
    const origin = LOOPBACK_HOSTS.has(url.hostname) ? url.origin : `https://${options.host}`;
    if (url.search) return fail(400, "Query parameters are not accepted");
    const route = `${request.method} ${url.pathname}`;
    if (!["GET /api/session", "GET /api/schema", "POST /api/query", "POST /api/facts"].includes(route)) {
      return fail(url.pathname.startsWith("/api/") && ["/api/session", "/api/schema", "/api/query", "/api/facts"].includes(url.pathname) ? 405 : 404, "Not found");
    }
    // Same-origin browser calls only. JSON bodies force a CORS preflight that
    // this API never answers, and an explicit foreign Origin is rejected.
    const requestOrigin = request.headers.get("origin");
    if (requestOrigin !== null && requestOrigin !== origin) return fail(403, "Cross-origin requests are not allowed");
    const fetchSite = request.headers.get("sec-fetch-site");
    if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") return fail(403, "Cross-site requests are not allowed");

    const visitor = identify(request);
    const admitted = await admit(env.API_RATE_LIMITER, `api:${visitor.rateKey}`, API_RATE_LIMIT.simple.period);
    if (admitted) return admitted;

    if (route === "GET /api/session") {
      return json({ ...options.session, graphId: options.graphId, user: { author: visitor.author }, limits: API_LIMITS, writableValueTypes: WRITABLE_VALUE_TYPES });
    }
    if (route === "GET /api/schema") return schema(env, options.graphId);
    const body = await readJson(request);
    if (!body.ok) return body.response;
    if (route === "POST /api/query") return query(env, options.graphId, body.value);
    const writeAdmitted = await admit(env.WRITE_RATE_LIMITER, `write:${visitor.rateKey}`, WRITE_RATE_LIMIT.simple.period);
    if (writeAdmitted) return writeAdmitted;
    return write(env, options.graphId, visitor, body.value);
  };
}

function identify(request: Request): Visitor {
  // Rate limits key on the edge-set client IP; missing edge metadata (local
  // dev, direct invocation) shares one bucket.
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  return { author: ANONYMOUS_AUTHOR, rateKey: ip && ip.length <= 64 ? `ip:${ip}` : "ip:unknown-client" };
}

async function admit(limiter: Limiter | undefined, key: string, period: number): Promise<Response | undefined> {
  if (!limiter) return fail(503, "Rate limiter unavailable; try again shortly", {}, { "retry-after": "60" });
  try {
    const { success } = await limiter.limit({ key });
    return success ? undefined : fail(429, "Too many requests; try again in a minute", {}, { "retry-after": String(period) });
  } catch {
    // Fail closed: an unavailable limiter never means unlimited.
    return fail(503, "Rate limiter unavailable; try again shortly", {}, { "retry-after": "60" });
  }
}

async function readJson(request: Request): Promise<Parsed<Record<string, unknown>>> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return { ok: false, response: fail(415, "Expected application/json") };
  }
  if (!request.body) return { ok: false, response: fail(400, "Expected a JSON object body") };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > API_LIMITS.requestBytes) { await reader.cancel(); return { ok: false, response: fail(413, `Request body exceeds ${API_LIMITS.requestBytes} bytes`) }; }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
    return { ok: true, value: value as Record<string, unknown> };
  } catch { return { ok: false, response: fail(400, "Expected a JSON object body") }; }
}

function elapsed(started: number): number { return Math.round((performance.now() - started) * 100) / 100; }
function serverTiming(entries: Record<string, number | undefined>): string {
  return Object.entries(entries).filter(([, value]) => value !== undefined).map(([name, value]) => `${name};dur=${value}`).join(", ");
}

// Errors cross Worker RPC as plain records. Only a safe status and the
// service's already-sanitized message are forwarded; never stacks or causes.
type SafeFailure = Readonly<{ status?: number; message?: string; input: boolean }>;
function safeFailure(error: unknown): SafeFailure {
  if (typeof error !== "object" || error === null) return { input: false };
  const record = error as Record<string, unknown>;
  const status = typeof record["status"] === "number" && Number.isInteger(record["status"]) && record["status"] >= 400 && record["status"] <= 599 ? record["status"] : undefined;
  const message = typeof record["message"] === "string" && record["message"].length <= 500 ? record["message"] : undefined;
  // The service re-throws sanitized Poneglyph errors; RPC preserves their name.
  return { status, message, input: record["name"] === "PoneglyphInputError" };
}

async function query(env: ApiEnv, graphId: string, body: Record<string, unknown>): Promise<Response> {
  if (Object.keys(body).some(key => key !== "query") || typeof body["query"] !== "string") return fail(400, "Expected {\"query\": \"...\"}");
  const source = body["query"];
  if (source.trim().length === 0) return fail(400, "Query is empty");
  if (source.length > API_LIMITS.queryCharacters) return fail(400, `Query exceeds ${API_LIMITS.queryCharacters} characters`);
  if (!env.PONEGLYPH) return fail(503, "Database binding is unavailable");
  const started = performance.now();
  try {
    const result = await env.PONEGLYPH.query({ graphId, query: source });
    const serverMs = elapsed(started);
    return json({ rows: result.rows, snapshotSeq: result.snapshotSeq, metrics: result.metrics, timing: { serverMs } }, 200, {
      "server-timing": serverTiming({ worker: serverMs, db: result.metrics.timing?.executionMs, eval: result.metrics.timing?.evaluationMs }),
    });
  } catch (error) {
    const failure = safeFailure(error);
    const serverMs = elapsed(started);
    if (failure.input || (failure.status !== undefined && failure.status < 500)) {
      return fail(failure.status ?? 400, failure.message ?? "Invalid query", { kind: "rejected", timing: { serverMs } });
    }
    console.error(JSON.stringify({ event: "playground-query-unavailable", status: failure.status }));
    return fail(502, "The database couldn't answer right now; try again", { kind: "unavailable", timing: { serverMs } });
  }
}

async function schema(env: ApiEnv, graphId: string): Promise<Response> {
  if (!env.PONEGLYPH) return fail(503, "Database binding is unavailable");
  const started = performance.now();
  try {
    using graph = await env.PONEGLYPH.getGraph({ graphId });
    const observed = await graph.getSchema();
    return json({ schema: observed, timing: { serverMs: elapsed(started) } });
  } catch (error) {
    const failure = safeFailure(error);
    console.error(JSON.stringify({ event: "playground-schema-unavailable", status: failure.status }));
    return fail(502, "Couldn't list fields", { timing: { serverMs: elapsed(started) } });
  }
}

type WriteRequest = Readonly<{ facts: readonly FactInput[]; requestToken: string }>;
const TOKEN = /^[A-Za-z0-9-]{8,64}$/;

export function parseWriteRequest(body: Record<string, unknown>, author: string): { ok: true; value: WriteRequest } | { ok: false; error: string } {
  if (Object.keys(body).some(key => key !== "facts" && key !== "requestToken")) return { ok: false, error: "Expected {\"facts\": [...], \"requestToken\": \"...\"}" };
  const token = body["requestToken"];
  if (typeof token !== "string" || !TOKEN.test(token)) return { ok: false, error: "requestToken must be 8–64 letters, digits or hyphens" };
  const input = body["facts"];
  if (!Array.isArray(input) || input.length === 0) return { ok: false, error: "Submit at least one fact" };
  if (input.length > API_LIMITS.factsPerWrite) return { ok: false, error: `Submit at most ${API_LIMITS.factsPerWrite} facts per transaction` };
  const facts: FactInput[] = [];
  for (const [index, candidate] of input.entries()) {
    const fact = parseFact(candidate, author);
    if (typeof fact === "string") return { ok: false, error: `facts[${index}]: ${fact}` };
    facts.push(fact);
  }
  return { ok: true, value: { facts, requestToken: token } };
}

function parseFact(input: unknown, author: string): FactInput | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "expected an object";
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some(key => !["entity", "field", "value", "retraction"].includes(key))) return "only entity, field, value and retraction are accepted; the source is assigned by the playground";
  const { entity, field, value, retraction } = record;
  if (typeof entity !== "string" || entity.length === 0 || entity.length > 512) return "entity must be a URI of at most 512 characters";
  if (typeof field !== "string" || field.length === 0 || field.length > 256) return "field must be a URI of at most 256 characters";
  if (retraction !== undefined && typeof retraction !== "boolean") return "retraction must be a boolean";
  const parsedValue = parseValue(value);
  if (typeof parsedValue === "string") return parsedValue;
  // Storage parses URIs and typed values again; this only bounds and shapes input.
  return { source: `playground:author:${author}`, entity, field, value: parsedValue, retraction: retraction === true };
}

function parseValue(input: unknown): FactValue | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "value must be {type, value}";
  const record = input as Record<string, unknown>;
  const type = record["type"];
  if (!WRITABLE_VALUE_TYPES.includes(type as WritableValueType) || Object.keys(record).some(key => key !== "type" && key !== "value")) {
    return `value.type must be one of ${WRITABLE_VALUE_TYPES.join(", ")}`;
  }
  const value = record["value"];
  if (type === "boolean") return typeof value === "boolean" ? { type, value } : "boolean values must be true or false";
  if (typeof value !== "string" || value.length > API_LIMITS.valueCharacters) return `value must be a string of at most ${API_LIMITS.valueCharacters} characters`;
  if (type === "number" && !/^-?(?:0|[1-9][0-9]{0,18})$/.test(value)) return "number values must be signed 64-bit integers written as decimal strings";
  return { type, value } as FactValue;
}

async function write(env: ApiEnv, graphId: string, visitor: Visitor, body: Record<string, unknown>): Promise<Response> {
  const parsed = parseWriteRequest(body, visitor.author);
  if (!parsed.ok) return fail(400, parsed.error, { delivery: "not-sent" });
  if (!env.PONEGLYPH_WRITER) return fail(503, "Write binding is unavailable", { delivery: "not-sent" });
  // The author scope makes tokens per-user; replaying the same token and
  // facts is idempotent, so the browser may safely retry an unknown outcome.
  const clientRequestToken = `playground:${visitor.author}:${parsed.value.requestToken}`;
  const started = performance.now();
  try {
    using graph = await env.PONEGLYPH_WRITER.getGraph({ graphId });
    const receipt = await graph.transact(parsed.value.facts, { clientRequestToken });
    const serverMs = elapsed(started);
    return json({ txId: receipt.txId, facts: parsed.value.facts, requestToken: parsed.value.requestToken, timing: { serverMs } }, 200, {
      "server-timing": serverTiming({ worker: serverMs }),
    });
  } catch (error) {
    const failure = safeFailure(error);
    const serverMs = elapsed(started);
    // A 4xx is a definitive answer from storage (invalid, conflicting token, or
    // aborted); nothing was applied. Anything else leaves delivery unknown.
    if (failure.input || (failure.status !== undefined && failure.status < 500)) {
      return fail(failure.status ?? 400, failure.message ?? "Not saved", { delivery: "rejected", timing: { serverMs } });
    }
    console.error(JSON.stringify({ event: "playground-write-unknown", status: failure.status }));
    return fail(503, "We don't know if this was saved. Retrying won't create duplicates.", {
      delivery: "unknown", requestToken: parsed.value.requestToken, timing: { serverMs },
    });
  }
}
