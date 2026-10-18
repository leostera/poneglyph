import assert from "node:assert/strict";
import {test} from "node:test";
import {latencyStats, parseProbeResult, parseReadPlan, successful, transportFailure, type Sample} from "../bench/plan.js";
import {settledWaves} from "../bench/waves.js";

const metrics = {snapshotSeq: 1, hostedMs: 8, serviceMs: 7, snapshotMs: 7, evaluationMs: 0, releaseMs: 0, cacheHits: 1, leases: 0};

test("read benchmark parses exact bounded plans without exposing destination or query inputs", () => {
  const plan = parseReadPlan({phases: [{kind: "combined", count: 10, concurrency: 8}]});
  assert.deepEqual(plan, {phases: [{kind: "combined", count: 10, concurrency: 8}]});
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.phases) && Object.isFrozen(plan.phases[0]));
  for (const raw of [undefined, {}, {phases: []}, {phases: [{kind: "combined", count: 1, concurrency: 0}]},
    {phases: [{kind: "combined", count: 10, concurrency: 1.5}]},
    {phases: [{kind: "arbitrary-query", count: 10, concurrency: 8}]},
    {phases: [{kind: "combined", count: 10, concurrency: 8, query: "private"}]},
    {phases: [{kind: "point", count: 10000, concurrency: 8}, {kind: "combined", count: 1, concurrency: 1}]},
    {phases: Array.from({length: 101}, () => ({kind: "point", count: 1, concurrency: 1}))},
    {phases: [{kind: "combined", count: 10, concurrency: 8}], target: "not-allowed"},
  ]) assert.throws(() => parseReadPlan(raw));
});

test("read benchmark parses complete and failed probes with exact run identity and finite metrics", () => {
  const complete = parseProbeResult({runId: "test-run", kind: "complete", metrics}, "test-run");
  assert.deepEqual(complete, {kind: "complete", metrics});
  assert.ok(Object.isFrozen(complete));
  assert.deepEqual(parseProbeResult({runId: "test-run", kind: "unavailable", hostedMs: 7}, "test-run"), {kind: "unavailable", hostedMs: 7});
  for (const raw of [null, {runId: "wrong-run", kind: "complete", metrics},
    {runId: "test-run", kind: "complete", metrics: {...metrics, serviceMs: Infinity}},
    {runId: "test-run", kind: "complete", metrics: {...metrics, cacheHits: -1}},
    {runId: "test-run", kind: "complete", metrics: {...metrics, snapshotSeq: .5}},
    {runId: "test-run", kind: "complete", metrics, unexpected: "private"},
    {runId: "test-run", kind: "unavailable", hostedMs: 7, cause: "private"},
  ]) assert.throws(() => parseProbeResult(raw, "test-run"));
});

test("read benchmark keeps deadline failures in all-outcome p99, never in successful service percentiles", () => {
  const samples: Sample[] = [
    ...Array.from({length: 475}, (): Sample => ({callerMs: 900, result: {kind: "complete", metrics}})),
    ...Array.from({length: 37}, (): Sample => ({callerMs: 30000, failure: "timeout"})),
  ];
  assert.equal(samples.filter(successful).length, 475);
  assert.equal(latencyStats(samples.map(sample => sample.callerMs)).p99, 30000);
  assert.equal(latencyStats(samples.filter(successful).map(sample => sample.callerMs)).p99, 900);
  assert.equal(latencyStats(samples.filter(successful).map(sample => sample.result.metrics.serviceMs)).p99, 7);
  assert.deepEqual(latencyStats([]), {count: 0, p50: null, p95: null, p99: null, max: null});
  assert.throws(() => latencyStats([-1]));
  assert.throws(() => latencyStats([NaN]));
});

test("read benchmark classifies transport evidence without exposing causes", () => {
  assert.equal(transportFailure(new DOMException("private", "TimeoutError")), "timeout");
  assert.equal(transportFailure(new DOMException("private", "AbortError")), "timeout");
  assert.equal(transportFailure(new SyntaxError("private")), "protocol");
  assert.equal(transportFailure(new TypeError("private timeout-like backend message")), "network");
  assert.equal(transportFailure("private"), "network");
});

test("read benchmark actually enforces advertised concurrency and issues each operation once", async () => {
  const visited = new Set<number>();
  let active = 0, measuredMaximum = 0;
  const result = await settledWaves({kind: "combined", count: 10000, concurrency: 64}, async index => {
    assert.equal(visited.has(index), false); visited.add(index);
    active++; measuredMaximum = Math.max(measuredMaximum, active);
    await Promise.resolve(); active--;
    return index;
  }, () => true);
  assert.equal(result.outcomes.length, 10000);
  assert.equal(result.observedMaxInFlight, 64);
  assert.equal(measuredMaximum, 64);
  assert.equal(active, 0);
  assert.equal(visited.size, 10000);
});

test("read benchmark drains all issued work after an unexpected rejection, then stops without retries", async () => {
  let issued = 0, completed = 0;
  const result = await settledWaves({kind: "point", count: 100, concurrency: 8}, async index => {
    issued++;
    try {
      if (index === 0) throw new Error("private cause must not enter the report");
      await Promise.resolve();
      return index;
    } finally { completed++; }
  }, wave => wave.every(outcome => outcome.status === "fulfilled"));
  assert.equal(issued, 8); assert.equal(completed, 8);
  assert.equal(result.outcomes.length, 8);
  assert.equal(result.outcomes[0]?.status, "rejected");
  assert.equal(result.observedMaxInFlight, 8);
  assert.equal(JSON.stringify(result).includes("private"), false);
});
