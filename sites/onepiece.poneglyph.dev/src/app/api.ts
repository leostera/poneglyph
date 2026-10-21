// Browser client for the playground's same-origin JSON API.

export type TypedValue = Readonly<{ type: string; value: string }>;
export type Row = Readonly<Record<string, TypedValue>>;
export type QueryTiming = Readonly<{ executionMs: number; snapshotMs: number; evaluationMs: number; releaseMs: number }>;
export type QueryMetrics = Readonly<{
  scanCalls: number; shardRequests: number; distinctShardsTouched?: number; treeReadLeaseAcquisitions?: number;
  tuplesRead: number; bytesRead: number; directoryRequests: number; cacheHits?: number; timing?: QueryTiming;
}>;
export type ExampleQuery = Readonly<{ id: string; title: string; description: string; query: string }>;
export type Session = Readonly<{
  graphId: string;
  user: { email: string; author: string };
  limits: { factsPerWrite: number; queryCharacters: number; valueCharacters: number };
  writableValueTypes: readonly string[];
  examples: readonly ExampleQuery[];
  dataset: { name: string; note: string; limitations: readonly string[]; entityIdentity: string; queryLanguage: string };
  mcp: { url: string; instructions: string };
}>;

export type QueryOutcome =
  | { ok: true; rows: readonly Row[]; snapshotSeq: number; metrics: QueryMetrics; roundTripMs: number; serverMs: number }
  | { ok: false; status: number; error: string; kind: "rejected" | "unavailable" | "transport"; roundTripMs: number; serverMs?: number };

export type FactDraft = { entity: string; field: string; value: { type: string; value: string | boolean }; retraction: boolean };
export type WriteOutcome =
  | { ok: true; txId: string; facts: readonly FactDraft[]; roundTripMs: number; serverMs: number }
  | { ok: false; status: number; error: string; delivery: "not-sent" | "rejected" | "unknown"; roundTripMs: number };

export class Unauthenticated extends Error {}

function now(): number { return performance.now(); }
function round(value: number): number { return Math.round(value * 10) / 10; }

async function call(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> | undefined }> {
  const response = await fetch(path, { ...init, credentials: "same-origin", headers: { ...(init?.body ? { "content-type": "application/json" } : {}), accept: "application/json" } });
  if (response.status === 401) throw new Unauthenticated();
  const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  return { status: response.status, body };
}

export async function getSession(): Promise<Session> {
  const { status, body } = await call("/api/session");
  if (status !== 200 || !body) throw new Error(typeof body?.["error"] === "string" ? body["error"] : `Session failed (HTTP ${status})`);
  return body as unknown as Session;
}

export async function runQuery(query: string): Promise<QueryOutcome> {
  const started = now();
  try {
    const { status, body } = await call("/api/query", { method: "POST", body: JSON.stringify({ query }) });
    const roundTripMs = round(now() - started);
    const serverMs = (body?.["timing"] as { serverMs?: number } | undefined)?.serverMs;
    if (status === 200 && body && Array.isArray(body["rows"])) {
      return { ok: true, rows: body["rows"] as Row[], snapshotSeq: body["snapshotSeq"] as number, metrics: body["metrics"] as QueryMetrics, roundTripMs, serverMs: serverMs ?? 0 };
    }
    return { ok: false, status, error: typeof body?.["error"] === "string" ? body["error"] : `HTTP ${status}`, kind: body?.["kind"] === "rejected" || (status >= 400 && status < 500) ? "rejected" : "unavailable", roundTripMs, serverMs };
  } catch (error) {
    if (error instanceof Unauthenticated) throw error;
    return { ok: false, status: 0, error: "Network error: the request did not complete", kind: "transport", roundTripMs: round(now() - started) };
  }
}

export async function submitFacts(facts: readonly FactDraft[], requestToken: string): Promise<WriteOutcome> {
  const started = now();
  try {
    const { status, body } = await call("/api/facts", { method: "POST", body: JSON.stringify({ facts, requestToken }) });
    const roundTripMs = round(now() - started);
    if (status === 200 && body && typeof body["txId"] === "string") {
      return { ok: true, txId: body["txId"], facts, roundTripMs, serverMs: (body["timing"] as { serverMs: number }).serverMs };
    }
    const delivery = body?.["delivery"] === "rejected" || body?.["delivery"] === "not-sent" ? body["delivery"] : status >= 400 && status < 500 ? "not-sent" : "unknown";
    return { ok: false, status, error: typeof body?.["error"] === "string" ? body["error"] : `HTTP ${status}`, delivery, roundTripMs };
  } catch (error) {
    if (error instanceof Unauthenticated) throw error;
    return { ok: false, status: 0, error: "Network error: the outcome is unknown", delivery: "unknown", roundTripMs: round(now() - started) };
  }
}

export type SchemaField = Readonly<{ field: string; valueTags: readonly string[] }>;
export type SchemaOutcome = { ok: true; fields: readonly SchemaField[]; snapshotSeq?: number; roundTripMs: number; serverMs: number } | { ok: false; error: string; roundTripMs: number };
export async function getSchema(): Promise<SchemaOutcome> {
  const started = now();
  const { status, body } = await call("/api/schema");
  const roundTripMs = round(now() - started);
  if (status !== 200 || !body) return { ok: false, error: typeof body?.["error"] === "string" ? body["error"] : `HTTP ${status}`, roundTripMs };
  const schema = body["schema"] as { fields?: SchemaField[]; snapshotSeq?: number };
  return { ok: true, fields: schema.fields ?? [], snapshotSeq: schema.snapshotSeq, roundTripMs, serverMs: (body["timing"] as { serverMs: number }).serverMs };
}

export function newRequestToken(): string { return crypto.randomUUID(); }
