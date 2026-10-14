import assert from "node:assert/strict";
import test from "node:test";
import { parseTransactionId } from "@leostera/poneglyph";
import { createImportHandler, type ImportEnv } from "../src/import.js";
import { IMPORT_ACCESS_AUDIENCE, IMPORT_BODY_BYTES, parseApprovedBatch, parseImportPlan } from "../src/import-contract.js";
import { body, fixturePlan, txId } from "./import-fixture.js";

const host = "onepiece.poneglyph.dev";
const authenticated = { access: { aud: IMPORT_ACCESS_AUDIENCE, getIdentity: async () => ({ email: "member@example.test" }) } };
const request = (text = body, init: RequestInit = {}) => new Request(`https://${host}/import`, { method: "POST", headers: { "content-type": "application/json" }, body: text, ...init });
function harness() {
  const plan = fixturePlan();
  let acquired = 0, writes = 0, disposed = 0, admissions = 0;
  const id = parseTransactionId(txId); if (!id.ok) throw new Error("Invalid test ID");
  const env: ImportEnv = {
    IMPORT_RATE_LIMITER: { limit: async () => { admissions++; return { success: true }; } },
    PONEGLYPH_IMPORT: { getGraph: async input => {
      assert.deepEqual(input, { graphId: "onepiece" }); acquired++;
      return { transact: async (facts, options) => { assert.equal(facts.length, 2); assert.deepEqual(options, { txId }); writes++; return { txId: id.value, commitSeq: 1, status: "committed" }; }, [Symbol.dispose]: () => { disposed++; } };
    } },
  };
  return { plan, env, handle: createImportHandler(plan, host), counts: () => ({ acquired, writes, disposed, admissions }) };
}

test("approved import preserves original identity, awaits receipt and disposes writer; no CORS credentials", async () => {
  const h = harness();
  const result = await h.handle(request(), h.env, authenticated);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { txId, commitSeq: 1, status: "committed", batch: 0, facts: 2 });
  assert.equal(result.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(h.counts(), { acquired: 1, writes: 1, disposed: 1, admissions: 1 });
});

test("host, method, origin and actual Access context deny before parsing/admission/storage; forged headers do not authenticate", async () => {
  for (const [req, ctx, status] of [
    [new Request("https://attacker.example/import", { method: "POST" }), authenticated, 403],
    [new Request(`https://${host}/import?graphId=attacker`, { method: "POST" }), authenticated, 404],
    [new Request(`https://${host}/import`, { method: "OPTIONS" }), authenticated, 405],
    [request(body, { headers: { origin: `https://${host}` } }), authenticated, 403],
    [request(body, { headers: { "cf-access-authenticated-user-email": "member@example.test", "cf-access-jwt-assertion": "forged" } }), {}, 401],
    [request(), { access: { ...authenticated.access, aud: "wrong-app" } }, 401],
    [request(), { access: { ...authenticated.access, getIdentity: async () => undefined } }, 403],
    [request(), { access: { ...authenticated.access, getIdentity: async () => { throw new Error("identity unavailable"); } } }, 503],
  ] as const) {
    const h = harness(); assert.equal((await h.handle(req, h.env, ctx)).status, status);
    assert.deepEqual(h.counts(), { acquired: 0, writes: 0, disposed: 0, admissions: 0 });
  }
});

test("missing/throwing/denying admission fails closed before storage", async () => {
  for (const [limiter, status] of [[undefined, 503], [{ limit: async () => { throw new Error("unavailable"); } }, 503], [{ limit: async () => ({ success: false }) }, 429]] as const) {
    const h = harness(); h.env.IMPORT_RATE_LIMITER = limiter;
    const response = await h.handle(request(), h.env, authenticated);
    assert.equal(response.status, status);
    assert.equal(h.counts().acquired, 0);
  }
});

test("actual streamed bytes, exact digest, batch count and JSON schema exclude all unapproved writes", async () => {
  for (const [text, status] of [
    [" ".repeat(IMPORT_BODY_BYTES + 1), 413], ["not json", 400],
    [body.replace("Fixture", "Changed"), 400], [JSON.stringify({ ...JSON.parse(body), graphId: "another" }), 400],
    [JSON.stringify({ ...JSON.parse(body), batch: 1 }), 400], [JSON.stringify([JSON.parse(body)]), 400],
  ] as const) {
    const h = harness(); assert.equal((await h.handle(request(text), h.env, authenticated)).status, status);
    assert.equal(h.counts().acquired, 0);
  }
  const h = harness();
  assert.equal((await h.handle(request(body, { headers: { "content-type": "text/plain" } }), h.env, authenticated)).status, 415);
});

test("closed window is a pre-admission denial, without refreshing terminal identity retention", async () => {
  const h = harness();
  const plan = parseImportPlan({ ...h.plan, openedAt: "2020-01-01T00:00:00Z", expiresAt: "2020-01-02T00:00:00Z" });
  assert.equal((await createImportHandler(plan, host)(request(), h.env, authenticated)).status, 410);
  assert.equal(h.counts().acquired, 0); assert.equal(h.counts().admissions, 0);
  assert.throws(() => parseImportPlan({ ...h.plan, expiresAt: "2100-01-01T00:00:00Z" }));
  assert.throws(() => parseImportPlan({ ...h.plan, selectedPages: 2 }));
  assert.throws(() => parseImportPlan({ ...h.plan, batches: [{ ...h.plan.batches[0], facts: 1001 }] }));
});

test("RPC/disposal failures remain unknown, without retry or invented abort", async () => {
  const h = harness(); let attempts = 0;
  h.env.PONEGLYPH_IMPORT.getGraph = async () => ({ transact: async () => { attempts++; throw new Error("private disconnected stack"); }, [Symbol.dispose]() {} });
  const response = await h.handle(request(), h.env, authenticated);
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.ok(typeof result === "object" && result !== null && "delivery" in result && "txId" in result);
  assert.equal(result.delivery, "unknown"); assert.equal(result.txId, txId);
  assert.doesNotMatch(JSON.stringify(result), /private disconnected/); assert.equal(attempts, 1);
});

test("independent approved parser retains complete typed payload and refuses altered transaction identity", async () => {
  const parsed = await parseApprovedBatch(new TextEncoder().encode(body), fixturePlan());
  assert.equal(parsed.batch.txId, txId); assert.deepEqual(parsed.batch.facts[1].value, { type: "number", value: "0" });
  await assert.rejects(() => parseApprovedBatch(new TextEncoder().encode(body.replace(txId, "attacker:changed")), fixturePlan()));
});
