import assert from "node:assert/strict";
import { test } from "vitest";
import worker from "../src/index.js";
import { GRAPH_HEADER, HOST, GRAPH_SCOPES } from "../src/registry.js";
type Env = Parameters<typeof worker.fetch>[1];
type Context = Parameters<typeof worker.fetch>[2];
const audience = "fixture-audience";
// Test doubles deliberately fail if admission reaches storage.
const service = new Proxy({} as Env["PONEGLYPH"], { get() { throw new Error("Storage must not be reached"); } });
const context = (aud: string) => ({ access: { aud } }) as Context;
const request = () => new Request(`https://${HOST}/mcp`, { method: "POST", headers: { [GRAPH_HEADER]: [...GRAPH_SCOPES.keys()][0]! }, body: "invalid-json" });
function env(limiter?: { limit(): Promise<{ success: boolean }> }): Env {
  return { ACCESS_AUDIENCE: audience, PONEGLYPH: service, MCP_RATE_LIMITER: limiter as Env["MCP_RATE_LIMITER"] };
}
test("Access, missing limiter, throwing limiter and rate denial all precede parsing/storage", async () => {
  assert.equal((await worker.fetch(request(), env(), context("wrong"))).status, 401);
  assert.equal((await worker.fetch(request(), { ...env(), ACCESS_AUDIENCE: "" }, context(""))).status, 401);
  assert.equal((await worker.fetch(request(), env(), context(audience))).status, 503);
  assert.equal((await worker.fetch(request(), env({ async limit() { throw new Error("Unavailable"); } }), context(audience))).status, 503);
  const denied = await worker.fetch(request(), env({ async limit() { return { success: false }; } }), context(audience));
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get("retry-after"), "60");
});
