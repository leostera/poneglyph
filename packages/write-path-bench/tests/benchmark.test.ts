import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildWorkers } from "../build.js";
import { entityForTitle, pageFacts } from "../corpus.js";
import { startLocal } from "../runtime.js";
import { drive, makeBatches, record } from "../driver.js";
import { verify } from "../audit.js";
import { SCENARIOS, summarize } from "../scenarios.js";

const facts = Array.from({ length: 200 }, (_, i) => ({ source: "bench:fixture", entity: `wiki:person:${i}`,
  field: "wiki:person:name", value: { type: "text" as const, value: `Person ${i}` }, retraction: false }));

test("title encoding is collision-free for old lossy-slug examples", () => {
  assert.notEqual(entityForTitle("A/B"), entityForTitle("A:B"));
  assert.notEqual(entityForTitle("Luffy"), entityForTitle("luffy"));
  assert.equal(pageFacts("Luffy", "0", "[[Zoro]] [[Zoro]] [[Category:Characters]]").length, 5);
});
test("scenario matrix includes 10,000 calls without calling them 10,000 RPS", () => {
  assert.deepEqual(SCENARIOS.at(-1), { name: "saturation", batchSize: 2, concurrency: 10000 });
  assert.equal(SCENARIOS.length, 4);
  assert.ok(SCENARIOS.every(scenario => scenario.concurrency > 1), "the load matrix must contain only concurrent cases");
  assert.equal(summarize([1, 2, 3]).p99Ms, null);
  const oversized = makeBatches(Array.from({ length: 1001 }, () => facts[0]!),
    { name: "invalid", batchSize: 1001, concurrency: 1 }, "oversized");
  assert.equal(oversized[0]!.facts.length, 1001, "the benchmark must not resize transactions to hide database limits");
});
test("capacity lookup pages respect SQL bindings for 100, 101, and 1,000 distinct entities", { timeout: 120000 }, async () => {
  await buildWorkers();
  const directory = await mkdtemp(resolve(tmpdir(), "poneglyph-write-path-sql-limit-"));
  let runtime = await startLocal("bench-sql-limit", directory, 1);
  try {
    for (const size of [100, 101, 1000]) {
      const input = Array.from({ length: size }, (_, i) => ({ ...facts[i % facts.length]!, entity: `wiki:person:sql-${size}-${i}` }));
      const batches = makeBatches(input, { name: "sql-limit", batchSize: 1000, concurrency: 1 }, `sql-limit-${size}`);
      const response = await fetch(runtime.endpoints[0]!, { method: "POST", headers: { authorization: `Bearer ${runtime.token}` }, body: batches[0]!.body });
      assert.equal(response.status, 200, await response.text());
      const replay = await fetch(runtime.endpoints[0]!, { method: "POST", headers: { authorization: `Bearer ${runtime.token}` }, body: batches[0]!.body });
      assert.equal(replay.status, 200);
    }
    const page = record(await runtime.audit("shard?after=0"));
    assert.equal((page.active as {count: number}[])[0]!.count, 1201);
    assert.equal((page.missingValues as {count: number}[])[0]!.count, 0);
    assert.equal((record(await runtime.query("wiki:person:name(Person, Name)")).rows as unknown[]).length, 1201);
    const token = runtime.token;
    await runtime.mf.dispose(); runtime = await startLocal("bench-sql-limit", directory, 1, token);
    const restored = record(await runtime.audit("shard?after=0"));
    assert.equal((restored.active as {count: number}[])[0]!.count, 1201);
    assert.equal((record(await runtime.query("wiki:person:name(Person, Name)")).rows as unknown[]).length, 1201);
  } finally { await runtime.mf.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("packaged transact path: parallel application Workers, auth, request-token replay, query, restart audit", { timeout: 120000 }, async () => {
  await buildWorkers();
  const directory = await mkdtemp(resolve(tmpdir(), "poneglyph-write-path-test-"));
  let runtime = await startLocal("bench-integration", directory, 4);
  try {
    const unauthorized = await fetch(runtime.endpoints[0]!, { method: "POST", body: "{}" });
    assert.equal(unauthorized.status, 401);
    const scenario = { name: "test", batchSize: 10, concurrency: 10 };
    const batches = makeBatches(facts, scenario, "integration");
    const result = await drive(batches, scenario, { endpoints: runtime.endpoints, token: runtime.token,
      maxAttempts: 12, attemptTimeoutMs: 30000, journal: resolve(directory, "outcomes.ndjson") });
    assert.equal(result.metrics.acknowledgedFacts, 200);
    assert.equal((await verify(runtime, batches, result.outcomes)).persistedFacts, 200);
    const replay = await fetch(runtime.endpoints[0]!, { method: "POST", headers: { authorization: `Bearer ${runtime.token}` }, body: batches[0]!.body });
    assert.equal(replay.status, 200);
    const conflicting = await fetch(runtime.endpoints[1]!, { method: "POST", headers: { authorization: `Bearer ${runtime.token}` },
      body: JSON.stringify({clientRequestToken: batches[0]!.txId, facts: [facts[19]]}) });
    assert.equal(conflicting.status, 409);
    const query = record(await runtime.query('wiki:person:name(Person, "Person 19")'));
    assert.equal((query.rows as unknown[]).length, 1);
    const malformed = await fetch(runtime.endpoints[0]!, { method: "POST", headers: { authorization: `Bearer ${runtime.token}` },
      body: JSON.stringify({clientRequestToken: "bad", facts: [{entity: "not a fact"}]}) });
    assert.equal(malformed.status, 400);
    const token = runtime.token;
    await runtime.mf.dispose();
    runtime = await startLocal("bench-integration", directory, 4, token);
    assert.equal((await verify(runtime, batches, result.outcomes)).persistedFacts, 200);
    const postRestartReplay = await fetch(runtime.endpoints[0]!, {method: "POST", headers: {authorization: `Bearer ${runtime.token}`}, body: batches[0]!.body});
    assert.equal(postRestartReplay.status, 200);
    assert.equal((record(await postRestartReplay.json()).txId), result.outcomes[0]?.serverTxId, "durable request-token mapping survives runtime restart");
  } finally { await runtime.mf.dispose(); await rm(directory, { recursive: true, force: true }); }
});
