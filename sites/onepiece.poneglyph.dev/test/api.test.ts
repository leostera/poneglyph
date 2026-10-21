import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ACCESS_AUDIENCE, createApiHandler, type ApiEnv } from "../src/api.js";

const ORIGIN = "https://onepiece.poneglyph.dev";
const handler = createApiHandler({ host: "onepiece.poneglyph.dev", graphId: "onepiece-wiki", session: {} });
const member = { access: { aud: ACCESS_AUDIENCE, getIdentity: async () => ({ email: "member@example.test" }) } } as unknown as Pick<ExecutionContext, "access">;
const allow = { limit: async () => ({ success: true }) };
const post = (path: string, body: unknown) => new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body) });
const write = { facts: [{ entity: "playground:x:1", field: "onepiece:name", value: { type: "text", value: "X" } }], requestToken: "token-1234" };
function writer(error: unknown): ApiEnv["PONEGLYPH_WRITER"] {
  return { async getGraph() { return { transact: async () => { throw error; }, [Symbol.dispose]() {} }; } };
}

describe("playground API admission and outcome classification", () => {
  it("rejects a foreign Access audience and missing identity", async () => {
    const wrongAudience = { access: { aud: "other", getIdentity: async () => ({ email: "a@b" }) } } as unknown as Pick<ExecutionContext, "access">;
    assert.equal((await handler(new Request(`${ORIGIN}/api/session`), { API_RATE_LIMITER: allow }, wrongAudience)).status, 401);
    const noEmail = { access: { aud: ACCESS_AUDIENCE, getIdentity: async () => undefined } } as unknown as Pick<ExecutionContext, "access">;
    assert.equal((await handler(new Request(`${ORIGIN}/api/session`), { API_RATE_LIMITER: allow }, noEmail)).status, 403);
  });

  it("fails closed without a limiter, when the limiter throws, and on exhaustion", async () => {
    assert.equal((await handler(new Request(`${ORIGIN}/api/session`), {}, member)).status, 503);
    assert.equal((await handler(new Request(`${ORIGIN}/api/session`), { API_RATE_LIMITER: { limit: async () => { throw new Error("down"); } } }, member)).status, 503);
    const limited = await handler(new Request(`${ORIGIN}/api/session`), { API_RATE_LIMITER: { limit: async () => ({ success: false }) } }, member);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    const writesLimited = await handler(post("/api/facts", write), { API_RATE_LIMITER: allow, WRITE_RATE_LIMITER: { limit: async () => ({ success: false }) } }, member);
    assert.equal(writesLimited.status, 429);
  });

  it("reports storage 4xx as definitive and everything else as unknown delivery", async () => {
    const env = (error: unknown): ApiEnv => ({ API_RATE_LIMITER: allow, WRITE_RATE_LIMITER: allow, PONEGLYPH_WRITER: writer(error) });
    const aborted = await handler(post("/api/facts", write), env({ name: "PoneglyphRequestError", status: 422, message: "Transaction aborted" }), member);
    assert.equal(aborted.status, 422);
    assert.equal((await aborted.json() as { delivery: string }).delivery, "rejected");
    const invalid = await handler(post("/api/facts", write), env({ name: "PoneglyphInputError", message: "bad uri" }), member);
    assert.equal(invalid.status, 400);
    for (const failure of [{ name: "PoneglyphRequestError", status: 503, message: "x" }, { name: "PoneglyphNetworkError" }, new Error("disconnected")]) {
      const unknown = await handler(post("/api/facts", write), env(failure), member);
      assert.equal(unknown.status, 503);
      const body = await unknown.json() as { delivery: string; requestToken: string };
      assert.equal(body.delivery, "unknown");
      assert.equal(body.requestToken, "token-1234");
    }
  });

  it("never forwards backend detail for unavailable reads", async () => {
    const env: ApiEnv = { API_RATE_LIMITER: allow, PONEGLYPH: { query: async () => { throw Object.assign(new Error("secret stack detail"), { status: 500 }); }, getGraph: async () => { throw new Error("x"); } } };
    const response = await handler(post("/api/query", { query: "a(B, C)" }), env, member);
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /secret/);
  });
});
