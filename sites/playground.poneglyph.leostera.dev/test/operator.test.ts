import assert from "node:assert/strict";
import test from "node:test";
import operator from "../src/operator.js";
import { TEST_TX_ID } from "../src/test-facts.js";

function fixtureService(run: Fetcher["fetch"]): Fetcher {
  return { fetch: run, connect: () => { throw new Error("operator must not create sockets"); } };
}

test("operator refuses public/browser/caller-controlled paths before private writes", async () => {
  const env = { PONEGLYPH: fixtureService(async () => { throw new Error("must not reach database"); }) };
  for (const [url, init, status] of [
    ["https://playground.poneglyph.leostera.dev/seed", { method: "POST" }, 403],
    ["http://127.0.0.1/seed", { method: "POST", headers: { origin: "https://attacker.example", "content-type": "application/json" } }, 403],
    ["http://127.0.0.1/seed", { method: "GET" }, 404],
    ["http://127.0.0.1/v1/graphs/another/transactions", { method: "POST" }, 404],
  ] as const) {
    assert.equal((await operator.fetch(new Request(url, init), env)).status, status);
  }
});

test("operator sends one fixed six-fact transaction and parses the actual receipt", async () => {
  let calls = 0;
  const env = { PONEGLYPH: fixtureService(async (input, init) => {
    calls++;
    assert.equal(String(input), "https://database.internal/v1/graphs/onepiece/transactions");
    const batch = JSON.parse(String(init?.body));
    assert.equal(batch.txId, TEST_TX_ID);
    assert.equal(batch.facts.length, 6);
    assert.equal(batch.facts[0].entity, "wiki:onepiece:page:Monkey%20D.%20Luffy");
    assert.equal(batch.facts[0].source, "fixture:onepiece-playground");
    assert.equal(batch.facts[5].value.value, "Roronoa Zoro");
    assert.ok(batch.facts.every((fact: { retraction: boolean }) => fact.retraction === false));
    return Response.json({ txId: TEST_TX_ID, status: "committed", commitSeq: 1 });
  }) };
  // Request data is not a write interface: it cannot select different facts/ID.
  const result = await operator.fetch(new Request("http://127.0.0.1/seed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ graphId: "attacker", txId: "different", facts: [] }) }), env);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { txId: TEST_TX_ID, status: "committed", commitSeq: 1, graphId: "onepiece", facts: 6, dataset: "synthetic-smoke-fixture; not wiki corpus" });
  assert.equal(calls, 1);
});
