import assert from "node:assert/strict";
import { test } from "node:test";
import { benchmarkWrites, boundedInteger, summarize } from "../src/main.ts";

test("bounded environment parameters reject invalid concurrency instead of widening the workload", () => {
  const name = "PONEGLYPH_EXAMPLE_TEST_BOUND", previous = process.env[name];
  try {
    delete process.env[name];
    assert.equal(boundedInteger(name, 2, 1, 4), 2);
    for (const input of ["0", "5", "1.5", "no", "Infinity"]) {
      process.env[name] = input;
      assert.throws(() => boundedInteger(name, 2, 1, 4));
    }
    process.env[name] = "4";
    assert.equal(boundedInteger(name, 2, 1, 4), 4);
  } finally {
    if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
  }
});

test("latency summary is deterministic and does not mutate samples", () => {
  const samples = [3, 1, 2];
  assert.deepEqual(summarize(samples), { p50: 2, p95: 3, p99: 3 });
  assert.deepEqual(samples, [3, 1, 2]);
});

test("bounded write driver accounts only fake operations and rejects failed commits", async () => {
  const issued: number[] = [];
  const report = await benchmarkWrites({ transactions: 4, concurrency: 2, factsPerTransaction: 3, entitiesPerTransaction: 2 }, async (index) => {
    issued.push(index);
    return { body: { status: "committed" }, response: Response.json({}) };
  });
  assert.deepEqual(issued.sort(), [0, 1, 2, 3]);
  assert.equal(report["transactions"], 4);
  for (const body of [{ status: "aborted" }, {}]) {
    await assert.rejects(benchmarkWrites({ transactions: 1, concurrency: 1, factsPerTransaction: 3, entitiesPerTransaction: 2 }, async () => ({ body, response: Response.json({}) })), /not committed/);
  }
});

test("first failure stops new writes and drains the already admitted peer", async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const original = new Error("original unknown delivery"), issued: number[] = [];
  let settled = false;
  const pending = benchmarkWrites({ transactions: 8, concurrency: 2, factsPerTransaction: 3, entitiesPerTransaction: 2 }, async index => {
    issued.push(index);
    if (index === 0) { await ready; throw original; }
    entered(); await held;
    return { body: { status: "committed" }, response: Response.json({}) };
  });
  const result = pending.then(() => { settled = true; }, error => { settled = true; return error; });
  await ready;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "the peer must be drained before failure surfaces");
  assert.deepEqual(issued, [0, 1]);
  release();
  assert.equal(await result, original);
  assert.deepEqual(issued, [0, 1]);
});

test("invalid workload cannot admit a callback", async () => {
  let issued = 0;
  await assert.rejects(benchmarkWrites({ transactions: 1, concurrency: 0, factsPerTransaction: 3, entitiesPerTransaction: 2 }, async () => { issued++; return { body: {}, response: Response.json({}) }; }), /positive integer/);
  assert.equal(issued, 0);
});

test("built benchmark imports without issuing a load", async (t) => {
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("network forbidden"); });
  const entry = await import(new URL("../dist/main.js", import.meta.url).href);
  assert.equal(typeof entry.main, "function");
  assert.equal(network.mock.callCount(), 0);
});
