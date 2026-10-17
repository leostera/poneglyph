import { createWriteStream } from "node:fs";
import { once, setMaxListeners } from "node:events";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { parseFactBatch, type FactInput } from "@leostera/poneglyph";
import { summarize, type Scenario } from "./scenarios.js";

export type Batch = { txId: string; facts: readonly FactInput[]; body: string };
export type CallOutcome = { txId: string; serverTxId?: string; facts: number; kind: "committed" | "rejected" | "unknown"; attempts: number;
  latencyMs: number; status: number; databaseMs?: number; workerId?: string; detail?: string };
export type DriverOptions = { endpoints: string[]; token: string; maxAttempts: number; attemptTimeoutMs: number; journal: string;
  collectOutcomes?: boolean; onOutcome?: (outcome: CallOutcome) => void;
  onProgress?: (sample: { elapsedMs: number; acknowledgedFacts: number; completedCalls: number; outstanding: number; attempts: number }) => void };

export function makeBatches(facts: readonly FactInput[], scenario: Scenario, runId: string): Batch[] {
  const batches: Batch[] = [];
  for (let start = 0; start < facts.length; start += scenario.batchSize) {
    const txId = `bench:${runId}:${batches.length}`;
    const parsed = parseFactBatch({ txId, facts: facts.slice(start, start + scenario.batchSize) });
    if (!parsed.ok) throw new Error(`unsupported batch ${batches.length}: ${parsed.error.message}`);
    const body = JSON.stringify({clientRequestToken: txId, facts: parsed.value.facts});
    if (Buffer.byteLength(body) > 1_000_000) throw new Error(`unsupported batch ${batches.length}: exceeds 1 MB`);
    batches.push({ txId, facts: parsed.value.facts, body });
  }
  return batches;
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected response object");
  return value as Record<string, unknown>;
}

async function callBatch(batch: Batch, endpoint: string, options: DriverOptions, attempts: { latency: number[]; statuses: Record<string, number> }): Promise<CallOutcome> {
  const started = performance.now();
  let status = 0, detail = "", sawUnknown = false;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    const attemptStarted = performance.now();
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
        body: batch.body, signal: AbortSignal.timeout(options.attemptTimeoutMs) });
      status = response.status;
      const body = record(await response.json());
      attempts.statuses[String(status)] = (attempts.statuses[String(status)] ?? 0) + 1;
      if (response.ok) {
        if (body.requestToken !== batch.txId || typeof body.txId !== "string") throw new Error("request-token receipt mismatch");
        return {txId: batch.txId, serverTxId: body.txId, facts: batch.facts.length, kind: "committed", attempts: attempt,
          latencyMs: performance.now() - started, status,
          ...(typeof body.databaseMs === "number" ? { databaseMs: body.databaseMs } : {}),
          ...(typeof body.workerId === "string" ? { workerId: body.workerId } : {}) };
      }
      detail = String(body.error ?? "request failed").slice(0, 300);
      if (body.retryable !== true) return { txId: batch.txId, facts: batch.facts.length, kind: sawUnknown ? "unknown" : "rejected",
        attempts: attempt, latencyMs: performance.now() - started, status, detail };
      // Busy admission is known not to commit, but server/network failures may be ambiguous.
      if (status >= 500) sawUnknown = true;
    } catch (error) {
      sawUnknown = true; status = 0;
      detail = error instanceof Error ? `${error.message}${error.cause ? `: ${String(error.cause)}` : ""}` : String(error);
      attempts.statuses.transport = (attempts.statuses.transport ?? 0) + 1;
    } finally { attempts.latency.push(performance.now() - attemptStarted); }
    if (attempt === options.maxAttempts) return { txId: batch.txId, facts: batch.facts.length, kind: "unknown",
      attempts: attempt, latencyMs: performance.now() - started, status, detail: `retry budget exhausted: ${detail}` };
    await sleep(Math.random() * Math.min(5000, 100 * 2 ** (attempt - 1)));
  }
  throw new Error("unreachable retry state");
}

export async function drive(batches: Iterable<Batch> | AsyncIterable<Batch>, scenario: Scenario, options: DriverOptions) {
  const journal = createWriteStream(options.journal, { flags: "a" });
  setMaxListeners(scenario.concurrency + 2, journal);
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  const cpuStarted = process.cpuUsage();
  const outcomes: CallOutcome[] = [];
  const logicalLatency: number[] = [], committedLatency: number[] = [], databaseLatency: number[] = [];
  const failureExamples: { status: number; detail?: string }[] = [];
  const workerDistribution: Record<string, number> = {};
  const attempts = { latency: [] as number[], statuses: {} as Record<string, number> };
  const iterator = (async function* () { for await (const batch of batches) yield batch; })();
  let next = 0, outstanding = 0, peak = 0, area = 0, changedAt = performance.now();
  let committedFacts = 0, committedCalls = 0, completed = 0, rejected = 0, unknown = 0;
  const started = changedAt;
  const changeOutstanding = (delta: number) => {
    const now = performance.now(); area += outstanding * (now - changedAt); changedAt = now;
    outstanding += delta; peak = Math.max(peak, outstanding);
  };
  const interval: { elapsedMs: number; acknowledgedFacts: number; completedCalls: number; outstanding: number }[] = [];
  const sampler = setInterval(() => {
    const sample = { elapsedMs: performance.now() - started, acknowledgedFacts: committedFacts, completedCalls: completed, outstanding };
    interval.push(sample);
    if (interval.length % 30 === 0) {
      console.log(`${scenario.name}: ${completed} calls completed, ${committedFacts} facts acknowledged, ${outstanding} outstanding`);
      options.onProgress?.({ ...sample, attempts: attempts.latency.length });
    }
  }, 1000);
  try {
    await Promise.all(Array.from({ length: scenario.concurrency }, async () => {
      while (true) {
        const item = await iterator.next();
        if (item.done) return;
        const ordinal = next++;
        changeOutstanding(1);
        const outcome = await callBatch(item.value, options.endpoints[ordinal % options.endpoints.length]!, options, attempts);
        changeOutstanding(-1); completed++;
        options.onOutcome?.(outcome);
        if (options.collectOutcomes !== false) outcomes.push(outcome);
        logicalLatency.push(outcome.latencyMs);
        if (outcome.kind === "committed") {
          committedCalls++; committedFacts += outcome.facts; committedLatency.push(outcome.latencyMs);
          if (outcome.databaseMs !== undefined) databaseLatency.push(outcome.databaseMs);
          const worker = outcome.workerId ?? "unknown";
          workerDistribution[worker] = (workerDistribution[worker] ?? 0) + 1;
        } else {
          if (outcome.kind === "rejected") rejected++; else unknown++;
          if (failureExamples.length < 10) failureExamples.push({ status: outcome.status, detail: outcome.detail });
        }
        if (!journal.write(JSON.stringify(outcome) + "\n")) await once(journal, "drain");
      }
    }));
  } finally { clearInterval(sampler); loopDelay.disable(); journal.end(); await once(journal, "finish"); }
  const elapsedMs = performance.now() - started;
  const cpuMicroseconds = process.cpuUsage(cpuStarted);
  return { outcomes, metrics: { elapsedMs, plannedCallsAttempted: completed, acknowledgedFacts: committedFacts, acknowledgedTransactions: committedCalls,
    factsPerSecond: committedFacts * 1000 / elapsedMs, transactionsPerSecond: committedCalls * 1000 / elapsedMs,
    rejected, unknown, attempts: attempts.latency.length, statuses: attempts.statuses,
    logicalLatency: summarize(logicalLatency), committedLogicalLatency: summarize(committedLatency), attemptLatency: summarize(attempts.latency),
    driver: { cpuMicroseconds, eventLoopDelayMeanMs: loopDelay.mean / 1e6,
      eventLoopDelayMaxMs: loopDelay.max / 1e6, memoryBytes: process.memoryUsage() }, failureExamples,
    databaseAwaitLatency: summarize(databaseLatency), achievedConcurrency: { peak, mean: area / elapsedMs, target: scenario.concurrency }, interval,
    workerDistribution } };
}
