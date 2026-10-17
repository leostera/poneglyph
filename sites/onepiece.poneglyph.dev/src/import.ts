import type { FactInput, TransactionReceipt } from "@leostera/poneglyph";
import { IMPORT_ACCESS_AUDIENCE, IMPORT_BODY_BYTES, IMPORT_RATE_LIMIT, parseApprovedBatch, type ImportPlan } from "./import-contract.js";

interface ImportGraph extends Disposable { transactApprovedBatch(facts: readonly FactInput[], options: { txId: string }): Promise<Readonly<{txId: string; commitSeq: number; status: "committed"}>> }
export interface ImportEnv {
  PONEGLYPH_IMPORT: { getGraph(input: { graphId: string }): Promise<ImportGraph> };
  IMPORT_RATE_LIMITER?: Pick<RateLimit, "limit">;
}
const reply = (status: number, error: string) => Response.json({ error, delivery: "not-admitted" }, { status, headers: { "cache-control": "no-store" } });
const SAFE_WRITE_ERROR_NAMES = new Set([
  "Error", "PoneglyphInputError", "PoneglyphNetworkError", "PoneglyphProtocolError", "PoneglyphRequestError",
]);
type SafeWriteFailure = Readonly<{ name: string; status?: number; retryable?: boolean; upstreamOutcome: "transaction-aborted" | "upstream-unavailable" | "upstream-rejected" | "delivery-unknown" }>;

function parseSafeWriteFailure(input: unknown): SafeWriteFailure {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { name: "unknown", upstreamOutcome: "delivery-unknown" };
  const record = input as Readonly<Record<string, unknown>>;
  const name = typeof record["name"] === "string" && SAFE_WRITE_ERROR_NAMES.has(record["name"])
    ? record["name"]
    : "unknown";
  const status = typeof record["status"] === "number" && Number.isInteger(record["status"])
    && record["status"] >= 100 && record["status"] <= 599
    ? record["status"]
    : undefined;
  const retryable = typeof record["retryable"] === "boolean" ? record["retryable"] : undefined;
  const upstreamOutcome = status === 422 ? "transaction-aborted"
    : status !== undefined && status >= 500 ? "upstream-unavailable"
      : status === undefined ? "delivery-unknown" : "upstream-rejected";
  return {
    name,
    ...(status === undefined ? {} : { status }),
    ...(retryable === undefined ? {} : { retryable }),
    upstreamOutcome,
  };
}

async function readBody(request: Request): Promise<Uint8Array | undefined> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > IMPORT_BODY_BYTES) { await reader.cancel(); return undefined; }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export function createImportHandler(plan: ImportPlan, host: string) {
  return async (request: Request, env: ImportEnv, ctx: Pick<ExecutionContext, "access">): Promise<Response> => {
    const url = new URL(request.url);
    if (url.hostname !== host) return reply(403, "Host is not allowed");
    if (url.pathname !== "/import" || url.search) return reply(404, "Not found");
    if (request.method !== "POST") return reply(405, "Import requires POST; no browser preflight bypass");
    if (request.headers.has("origin")) return reply(403, "Browser imports are not supported");
    // The runtime verifies Access. Headers/cookies supplied by callers are not
    // identity evidence. No ctx.access is propagated over service bindings.
    if (!ctx.access || ctx.access.aud !== IMPORT_ACCESS_AUDIENCE) return reply(401, "The configured Cloudflare Access application is required");
    try {
      const identity = await ctx.access.getIdentity();
      if (typeof identity?.email !== "string" || !identity.email) return reply(403, "Authenticated account member required");
    } catch { return reply(503, "Access identity unavailable"); }
    const now = Date.now();
    if (now < Date.parse(plan.openedAt) || now >= Date.parse(plan.expiresAt)) return reply(410, "Approved import window is closed");
    if (!env.IMPORT_RATE_LIMITER) return reply(503, "Import admission unavailable");
    const ip = request.headers.get("cf-connecting-ip")?.trim();
    try {
      const { success } = await env.IMPORT_RATE_LIMITER.limit({ key: ip && ip.length <= 64 ? `import:ip:${ip}` : "import:unknown-client" });
      if (!success) return Response.json({ error: "Import rate limit exceeded", delivery: "not-admitted" }, {
        status: 429, headers: { "retry-after": String(IMPORT_RATE_LIMIT.simple.period), "cache-control": "no-store" },
      });
    } catch { return reply(503, "Import admission unavailable"); }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return reply(415, "Import requires application/json");
    let approved: Awaited<ReturnType<typeof parseApprovedBatch>>;
    try {
      const bytes = await readBody(request);
      if (!bytes) return reply(413, "Import exceeds actual byte limit");
      approved = await parseApprovedBatch(bytes, plan);
    } catch { return reply(400, "Import batch does not match the approved plan"); }
    const { batch, ordinal } = approved;
    try {
      using graph = await env.PONEGLYPH_IMPORT.getGraph({ graphId: plan.graphId });
      const receipt = await graph.transactApprovedBatch(batch.facts, { txId: batch.txId });
      return Response.json({ ...receipt, batch: ordinal, facts: batch.facts.length }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      // Structured telemetry intentionally excludes messages, stacks, causes,
      // payloads and credentials; the write result still remains unknown.
      const failure = parseSafeWriteFailure(error);
      console.error(JSON.stringify({ event: "playground-import-write-unknown", batch: ordinal, ...failure }));
      // Never infer rejection from reconstructed RPC errors or a disconnected
      // invocation. Reconcile this exact ID/payload/service, not a new ID.
      return Response.json({ error: "Import delivery unknown; retain the original approved batch", delivery: "unknown", txId: batch.txId }, {
        status: 503, headers: { "cache-control": "no-store" },
      });
    }
  };
}
