import assert from "node:assert/strict";
import { test } from "vitest";
import { admitMcpRequest, RATE_LIMIT } from "../src/rate-limit.js";

const request = (ip?: string) => new Request("https://playground.poneglyph.leostera.dev/mcp", {
  method: "POST", headers: ip ? { "cf-connecting-ip": ip } : {},
});

test("configured public allowance is 30 requests per 60 seconds", () => {
  assert.deepEqual(RATE_LIMIT.simple, { limit: 30, period: 60 });
  assert.match(RATE_LIMIT.namespace, /^[1-9][0-9]*$/);
});

test("admission uses edge IP, not caller-controlled identity headers", async () => {
  const keys: string[] = [];
  const limiter = { limit: async ({ key }: RateLimitOptions) => { keys.push(key); return { success: true }; } };
  const first = request("203.0.113.1");
  first.headers.set("x-forwarded-for", "198.51.100.2");
  first.headers.set("authorization", "Bearer irrelevant-client-identity");
  assert.equal(await admitMcpRequest(first, limiter), undefined);
  assert.equal(await admitMcpRequest(request("203.0.113.2"), limiter), undefined);
  assert.deepEqual(keys, ["mcp:ip:203.0.113.1", "mcp:ip:203.0.113.2"]);
});

test("missing edge identity shares a bucket, never unlimited access", async () => {
  const keys: string[] = [];
  const limiter = { limit: async ({ key }: RateLimitOptions) => { keys.push(key); return { success: false }; } };
  for (const input of [request(), request("x".repeat(65))]) {
    const response = await admitMcpRequest(input, limiter);
    assert.equal(response?.status, 429);
    assert.equal(response?.headers.get("retry-after"), "60");
    assert.equal(response?.headers.get("cache-control"), "no-store");
  }
  assert.deepEqual(keys, ["mcp:unknown-client", "mcp:unknown-client"]);
});

test("missing or failing limiter fails closed", async () => {
  assert.equal((await admitMcpRequest(request(), undefined))?.status, 503);
  assert.equal((await admitMcpRequest(request(), { limit: async () => { throw new Error("limiter failure"); } }))?.status, 503);
});
