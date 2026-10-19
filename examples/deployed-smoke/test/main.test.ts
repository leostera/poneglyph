import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { deploymentUrl, main } from "../src/main.ts";

const target = { PONEGLYPH_CLOUDFLARE_URL: "https://approved.poneglyph.leostera.dev" };

function fakeEndpoint(corrupt = false) {
  const writes: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const body: Record<string, unknown> = JSON.parse(String(init?.body));
    if (String(input).endsWith("/transactions")) {
      writes.push(body);
      return Response.json({txId: "poneglyph:tx:smoke-witness"});
    }
    const facts = writes[0]?.["facts"] as { entity: string; value: { value: string } }[];
    const rows = facts.map(fact => ({ Entity: { type: "string", value: fact.entity }, Name: { type: "string", value: fact.value.value } }));
    if (corrupt) rows[0]!.Name.value = "wrong value with unchanged row count";
    return Response.json({ snapshotSeq: 11, rows, metrics: { scanCalls: 1, shardRequests: 16, tuplesRead: 4, bytesRead: 400, directoryRequests: 16 } });
  };
  return { writes, fetcher };
}

test("deployment target is explicit and rejects credentials, unrelated hosts and hidden URL components", () => {
  assert.equal(deploymentUrl(target.PONEGLYPH_CLOUDFLARE_URL).origin, target.PONEGLYPH_CLOUDFLARE_URL);
  for (const input of [undefined, "", "http://approved.poneglyph.leostera.dev", "https://elsewhere.example", "https://user:secret@approved.poneglyph.leostera.dev", `${target.PONEGLYPH_CLOUDFLARE_URL}?token=secret`, `${target.PONEGLYPH_CLOUDFLARE_URL}/wrong`]) {
    assert.throws(() => deploymentUrl(input));
  }
});

test("smoke verifies original identity/payload and exact typed rows without assuming a one-root/global clock", async () => {
  const endpoint = fakeEndpoint(), log = vi.spyOn(console, "log").mockImplementation(() => {});
  await main(target, endpoint.fetcher);
  assert.equal(endpoint.writes.length, 2);
  assert.equal(typeof endpoint.writes[0]?.["clientRequestToken"], "string");
  assert.equal(Object.hasOwn(endpoint.writes[0]!, "txId"), false);
  assert.deepEqual(endpoint.writes[0], endpoint.writes[1]);
  assert.equal(log.mock.calls.length, 1);
});

test("unchanged row count cannot hide an incorrect acknowledged value", async () => {
  await assert.rejects(main(target, fakeEndpoint(true).fetcher), /exact typed multiset/);
});

test("uncertain transport is surfaced once, not silently retried or counted as abort", async () => {
  let calls = 0;
  await assert.rejects(main(target, async () => { calls++; throw new Error("transport failed"); }), /could not reach/);
  assert.equal(calls, 1);
});

test("built cloud smoke imports without contacting an endpoint", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("network forbidden"); });
  const entry = await import(new URL("../dist/main.js", import.meta.url).href);
  assert.equal(typeof entry.main, "function");
  assert.equal(network.mock.calls.length, 0);
});
