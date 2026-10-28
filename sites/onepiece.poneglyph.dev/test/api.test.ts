import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ANONYMOUS_AUTHOR, createApiHandler, type ApiEnv } from "../src/api.js";

const ORIGIN = "https://onepiece.poneglyph.dev";
const handler = createApiHandler({ host: "onepiece.poneglyph.dev", graphId: "onepiece-wiki", session: {} });
const allow = { limit: async () => ({ success: true }) };
const post = (path: string, body: unknown) => new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body) });
const write = { facts: [{ entity: "playground:x:1", field: "onepiece:name", value: { type: "text", value: "X" } }], requestToken: "token-1234" };
function writer(error: unknown): ApiEnv["PONEGLYPH_WRITER"] {
  return { async getGraph() { return { transact: async () => { throw error; }, [Symbol.dispose]() {} }; } };
}

describe("playground API admission and outcome classification", () => {
  it("admits anonymous visitors under a shared author, rate limited per edge IP", async () => {
    const keys: string[] = [];
    const recording = { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: true }; } };
    const response = await handler(new Request(`${ORIGIN}/api/session`, { headers: { "cf-connecting-ip": "203.0.113.7" } }), { API_RATE_LIMITER: recording });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { user: unknown }).user, { author: ANONYMOUS_AUTHOR });
    assert.equal((await handler(new Request(`${ORIGIN}/api/session`), { API_RATE_LIMITER: recording })).status, 200);
    assert.deepEqual(keys, ["api:ip:203.0.113.7", "api:ip:unknown-client"]);
  });

  it("fails closed without a limiter, when the limiter throws, and on exhaustion", async () => {
    assert.equal((await handler(new Request(`${ORIGIN}/api/session`), {})).status, 503);
    assert.equal((await handler(new Request(`${ORIGIN}/api/session`), { API_RATE_LIMITER: { limit: async () => { throw new Error("down"); } } })).status, 503);
    const limited = await handler(new Request(`${ORIGIN}/api/session`), { API_RATE_LIMITER: { limit: async () => ({ success: false }) } });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    const writesLimited = await handler(post("/api/facts", write), { API_RATE_LIMITER: allow, WRITE_RATE_LIMITER: { limit: async () => ({ success: false }) } });
    assert.equal(writesLimited.status, 429);
  });

  it("reports storage 4xx as definitive and everything else as unknown delivery", async () => {
    const env = (error: unknown): ApiEnv => ({ API_RATE_LIMITER: allow, WRITE_RATE_LIMITER: allow, PONEGLYPH_WRITER: writer(error) });
    const aborted = await handler(post("/api/facts", write), env({ name: "PoneglyphRequestError", status: 422, message: "Transaction aborted" }));
    assert.equal(aborted.status, 422);
    assert.equal((await aborted.json() as { delivery: string }).delivery, "rejected");
    const invalid = await handler(post("/api/facts", write), env({ name: "PoneglyphInputError", message: "bad uri" }));
    assert.equal(invalid.status, 400);
    for (const failure of [{ name: "PoneglyphRequestError", status: 503, message: "x" }, { name: "PoneglyphNetworkError" }, new Error("disconnected")]) {
      const unknown = await handler(post("/api/facts", write), env(failure));
      assert.equal(unknown.status, 503);
      const body = await unknown.json() as { delivery: string; requestToken: string };
      assert.equal(body.delivery, "unknown");
      assert.equal(body.requestToken, "token-1234");
    }
  });

  it("never forwards backend detail for unavailable reads", async () => {
    const env: ApiEnv = { API_RATE_LIMITER: allow, PONEGLYPH: { query: async () => { throw Object.assign(new Error("secret stack detail"), { status: 500 }); }, getGraph: async () => { throw new Error("x"); } } };
    const response = await handler(post("/api/query", { query: "a(B, C)" }), env);
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /secret/);
  });
});
