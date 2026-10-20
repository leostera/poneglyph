import {DurableObject} from "cloudflare:workers";

type Env = Record<string, never>;
type Write = Readonly<{key: string; value: string; requestToken: string}>;
type Latest = Readonly<{revision: number; value: string}>;
function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
function exactKeys(input: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key));
}
function validText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= maxBytes;
}
async function hash(value: Write): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([value.key, value.value])));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Benchmark-only sharded key owner: append-only per-key facts inside one bucket DO. */
export class LocalPointBucketDO extends DurableObject<Env> {
  private readonly latest = new Map<string, Latest>();
  private corruptState = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS point_bucket_facts (
        logical_key TEXT NOT NULL,
        revision INTEGER NOT NULL,
        value TEXT NOT NULL,
        request_token TEXT NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL,
        PRIMARY KEY (logical_key, revision)
      )`);
      const rows = ctx.storage.sql.exec<{logical_key: string; revision: number; value: string}>(`
        SELECT facts.logical_key, facts.revision, facts.value
        FROM point_bucket_facts AS facts
        JOIN (SELECT logical_key, MAX(revision) AS revision FROM point_bucket_facts GROUP BY logical_key) AS latest
          ON latest.logical_key = facts.logical_key AND latest.revision = facts.revision
      `).toArray();
      for (const row of rows) {
        if (!validText(row.logical_key, 512) || !Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.value !== "string") {
          this.corruptState = true;
          this.latest.clear();
          return;
        }
        this.latest.set(row.logical_key, Object.freeze({revision: row.revision, value: row.value}));
      }
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return Response.json({error: "method not allowed"}, {status: 405});
    const path = new URL(request.url).pathname;
    if (path !== "/write" && path !== "/read") return Response.json({error: "not found"}, {status: 404});
    let text: string;
    try { text = await request.text(); }
    catch { return Response.json({error: "invalid request body"}, {status: 400}); }
    if (new TextEncoder().encode(text).byteLength > 4_096) return Response.json({error: "request too large"}, {status: 413});
    let raw: unknown;
    try { raw = JSON.parse(text); }
    catch { return Response.json({error: "invalid JSON"}, {status: 400}); }
    if (!record(raw)) return Response.json({error: "invalid request"}, {status: 400});
    if (path === "/write") return this.write(raw);
    if (!exactKeys(raw, ["key"]) || !validText(raw["key"], 512)) return Response.json({error: "invalid read key"}, {status: 400});
    if (this.corruptState) return Response.json({error: "point bucket state is unavailable"}, {status: 503});
    const key = raw["key"], latest = this.latest.get(key);
    return latest === undefined ? Response.json({error: "point value not found"}, {status: 404}) :
      Response.json({key, revision: latest.revision, value: latest.value});
  }

  private async write(raw: Record<string, unknown>): Promise<Response> {
    if (!exactKeys(raw, ["key", "value", "requestToken"]) || !validText(raw["key"], 512) ||
        !validText(raw["value"], 1_024) || !validText(raw["requestToken"], 256)) {
      return Response.json({error: "invalid write"}, {status: 400});
    }
    const write: Write = {key: raw["key"], value: raw["value"], requestToken: raw["requestToken"]};
    const payloadHash = await hash(write);
    let result: Readonly<{revision: number; replayed: boolean}> | undefined;
    this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql.exec<{revision: number; payload_hash: string}>(
        "SELECT revision, payload_hash FROM point_bucket_facts WHERE request_token = ?", write.requestToken,
      ).toArray()[0];
      if (existing !== undefined) {
        if (existing.payload_hash !== payloadHash) throw new Error("request token payload conflict");
        result = {revision: existing.revision, replayed: true};
        return;
      }
      const revision = this.ctx.storage.sql.exec<{revision: number}>(
        "SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM point_bucket_facts WHERE logical_key = ?", write.key,
      ).one().revision;
      this.ctx.storage.sql.exec(
        "INSERT INTO point_bucket_facts (logical_key, revision, value, request_token, payload_hash) VALUES (?, ?, ?, ?, ?)",
        write.key, revision, write.value, write.requestToken, payloadHash,
      );
      result = {revision, replayed: false};
    });
    if (result !== undefined && !result.replayed) {
      const current = this.latest.get(write.key);
      if (current === undefined || current.revision < result.revision) {
        this.latest.set(write.key, Object.freeze({revision: result.revision, value: write.value}));
      }
    }
    return Response.json(result);
  }
}
