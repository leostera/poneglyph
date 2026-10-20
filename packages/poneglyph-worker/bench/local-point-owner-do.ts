import {DurableObject} from "cloudflare:workers";

const OWNER_KEY = "local-point-owner/key/v1";
type Env = Record<string, never>;
type Write = Readonly<{key: string; value: string; requestToken: string}>;

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
  const bytes = new TextEncoder().encode(JSON.stringify([value.key, value.value]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Benchmark-only alternative: one independently linearizable append-only owner
 * per control-plane key. It intentionally provides no graph-wide transactions,
 * Datalog joins, or cross-key snapshot; it is not a production Poneglyph class.
 */
export class LocalPointOwnerDO extends DurableObject<Env> {
  private ownerKey: string | undefined;
  private latest: Readonly<{revision: number; value: string}> | undefined;
  private corruptState = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS point_owner_facts (
        logical_key TEXT NOT NULL,
        revision INTEGER NOT NULL,
        value TEXT NOT NULL,
        request_token TEXT NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL,
        PRIMARY KEY (logical_key, revision)
      )`);
      const ownerKey: unknown = ctx.storage.kv.get(OWNER_KEY);
      if (ownerKey !== undefined && (typeof ownerKey !== "string" || ownerKey.length === 0)) {
        this.corruptState = true;
        return;
      }
      this.ownerKey = ownerKey as string | undefined;
      if (this.ownerKey === undefined) return;
      const latest = ctx.storage.sql.exec<{revision: number; value: string}>(
        "SELECT revision, value FROM point_owner_facts WHERE logical_key = ? ORDER BY revision DESC LIMIT 1", this.ownerKey,
      ).toArray()[0];
      if (latest === undefined || !Number.isSafeInteger(latest.revision) || latest.revision < 1 || typeof latest.value !== "string") {
        this.corruptState = true;
        return;
      }
      this.latest = Object.freeze({revision: latest.revision, value: latest.value});
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
    if (!exactKeys(raw, ["key"]) || !validText(raw["key"], 512)) {
      return Response.json({error: "invalid read key"}, {status: 400});
    }
    const key = raw["key"];
    if (this.corruptState) return Response.json({error: "point owner state is unavailable"}, {status: 503});
    if (this.ownerKey !== key) return Response.json({error: "point owner identity mismatch"}, {status: 409});
    return this.latest === undefined ? Response.json({error: "point value not found"}, {status: 404}) :
      Response.json({key, revision: this.latest.revision, value: this.latest.value});
  }

  private async write(raw: Record<string, unknown>): Promise<Response> {
    if (!exactKeys(raw, ["key", "value", "requestToken"]) || !validText(raw["key"], 512) ||
        !validText(raw["value"], 1_024) || !validText(raw["requestToken"], 256)) {
      return Response.json({error: "invalid write"}, {status: 400});
    }
    const write: Write = {key: raw["key"], value: raw["value"], requestToken: raw["requestToken"]};
    const payloadHash = await hash(write);
    const boundKey: unknown = this.ctx.storage.kv.get(OWNER_KEY);
    if (boundKey !== undefined && boundKey !== write.key) return Response.json({error: "point owner identity mismatch"}, {status: 409});

    let result: Readonly<{revision: number; replayed: boolean}> | undefined;
    this.ctx.storage.transactionSync(() => {
      const storedKey: unknown = this.ctx.storage.kv.get(OWNER_KEY);
      if (storedKey !== undefined && storedKey !== write.key) throw new Error("point owner identity mismatch");
      const existing = this.ctx.storage.sql.exec<{revision: number; payload_hash: string}>(
        "SELECT revision, payload_hash FROM point_owner_facts WHERE request_token = ?", write.requestToken,
      ).toArray()[0];
      if (existing !== undefined) {
        if (existing.payload_hash !== payloadHash) throw new Error("request token payload conflict");
        result = {revision: existing.revision, replayed: true};
        return;
      }
      const revision = this.ctx.storage.sql.exec<{revision: number}>(
        "SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM point_owner_facts WHERE logical_key = ?", write.key,
      ).one().revision;
      this.ctx.storage.kv.put(OWNER_KEY, write.key);
      this.ctx.storage.sql.exec(
        "INSERT INTO point_owner_facts (logical_key, revision, value, request_token, payload_hash) VALUES (?, ?, ?, ?, ?)",
        write.key, revision, write.value, write.requestToken, payloadHash,
      );
      result = {revision, replayed: false};
    });
    this.ownerKey = write.key;
    if (result !== undefined && !result.replayed && (this.latest === undefined || result.revision > this.latest.revision)) {
      this.latest = Object.freeze({revision: result.revision, value: write.value});
    }
    return Response.json(result);
  }
}
