import { createDatabase, PoneglyphInputError, PoneglyphRequestError } from "@leostera/poneglyph";

interface ApplicationEnv {
  DATABASE: Fetcher;
  GRAPH_ID: string;
  BENCH_TOKEN: string;
  WORKER_ID: string;
}

async function authorized(request: Request, token: string): Promise<boolean> {
  const encode = new TextEncoder();
  const [provided, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encode.encode(request.headers.get("authorization") ?? "")),
    crypto.subtle.digest("SHA-256", encode.encode(`Bearer ${token}`)),
  ]);
  let difference = 0;
  const a = new Uint8Array(provided), b = new Uint8Array(expected);
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return token.length > 0 && difference === 0;
}

async function readBody(request: Request): Promise<unknown> {
  if (request.body === null) throw new PoneglyphInputError("missing body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 1_100_000) {
      await reader.cancel();
      throw new PoneglyphInputError("benchmark envelope exceeds 1.1 MB");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new PoneglyphInputError("invalid JSON"); }
}

// Miniflare has one instance per application service. This is a local drain check,
// not a distributed cloud-isolate counter or a database visibility authority.
let inFlight = 0;
export default {
  async fetch(request: Request, env: ApplicationEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/__bench/activity") {
      if (!await authorized(request, env.BENCH_TOKEN)) return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json({ inFlight });
    }
    if (request.method !== "POST" || path !== "/facts") return new Response("not found", { status: 404 });
    inFlight++;
    try {
      if (!await authorized(request, env.BENCH_TOKEN)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const raw = await readBody(request);
      if (typeof raw !== "object" || raw === null || !("clientRequestToken" in raw) || !("facts" in raw) ||
          typeof raw.clientRequestToken !== "string" || !Array.isArray(raw.facts)) {
        throw new PoneglyphInputError("expected {clientRequestToken, facts}");
      }
      const db = await createDatabase({
        url: "https://poneglyph.internal", graphId: env.GRAPH_ID,
        fetch: (input, init) => env.DATABASE.fetch(input, init),
      });
      const started = performance.now();
      // The client parses each fact before sending it; success waits for the real database.
      const receipt = await db.transact(raw.facts, {clientRequestToken: raw.clientRequestToken});
      return Response.json({txId: receipt.txId, requestToken: raw.clientRequestToken, workerId: env.WORKER_ID, databaseMs: performance.now() - started});
    } catch (error) {
      if (error instanceof PoneglyphInputError) return Response.json({ error: error.message, retryable: false }, { status: 400 });
      if (error instanceof PoneglyphRequestError) return Response.json({ error: error.message, retryable: error.retryable }, { status: error.status });
      return Response.json({ error: "database outcome unknown", retryable: true }, { status: 502 });
    } finally { inFlight--; }
  },
};
