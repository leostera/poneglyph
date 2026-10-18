export type ReadPhase = Readonly<{kind: "point" | "combined"; count: number; concurrency: number}>;
export type ReadPlan = Readonly<{phases: readonly ReadPhase[]}>;
export type ProbeMetrics = Readonly<{
  snapshotSeq: number;
  hostedMs: number;
  serviceMs: number;
  snapshotMs: number;
  evaluationMs: number;
  releaseMs: number;
  cacheHits: number;
  leases: number;
}>;
export type ProbeResult =
  | Readonly<{kind: "complete"; metrics: ProbeMetrics}>
  | Readonly<{kind: "unavailable" | "unexpected-answer" | "invalid-metrics"; hostedMs: number}>;
export type Sample = Readonly<{callerMs: number; result: ProbeResult}>
  | Readonly<{callerMs: number; failure: "timeout" | "network" | "protocol"}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function positiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function counter(value: unknown): value is number {
  return nonnegative(value) && Number.isSafeInteger(value);
}

/** Operational harness bounds, never application admission/capacity limits. */
export function parseReadPlan(raw: unknown): ReadPlan {
  if (!record(raw) || !exactKeys(raw, ["phases"]) || !Array.isArray(raw.phases) || raw.phases.length < 1 || raw.phases.length > 100) {
    throw new Error("Expected a read plan with 1–100 phases");
  }
  const phases = raw.phases.map((phase: unknown): ReadPhase => {
    if (!record(phase) || !exactKeys(phase, ["kind", "count", "concurrency"]) ||
        phase.kind !== "point" && phase.kind !== "combined" ||
        !positiveInteger(phase.count, 10_000) || !positiveInteger(phase.concurrency, 1_024)) {
      throw new Error("Invalid read phase: expected a fixed query, 1–10000 calls and concurrency 1–1024");
    }
    return Object.freeze({kind: phase.kind, count: phase.count, concurrency: phase.concurrency});
  });
  if (phases.reduce((total, phase) => total + phase.count, 0) > 10_000) throw new Error("Read plan exceeds the 10000-call harness budget");
  return Object.freeze({phases: Object.freeze(phases)});
}

export function parseProbeResult(raw: unknown, runId: string): ProbeResult {
  if (!record(raw) || raw.runId !== runId) throw new Error("Unexpected read probe identity");
  if ((raw.kind === "unavailable" || raw.kind === "unexpected-answer" || raw.kind === "invalid-metrics") &&
      exactKeys(raw, ["runId", "kind", "hostedMs"]) && nonnegative(raw.hostedMs)) {
    return Object.freeze({kind: raw.kind, hostedMs: raw.hostedMs});
  }
  const metrics = raw.metrics;
  if (raw.kind !== "complete" || !exactKeys(raw, ["runId", "kind", "metrics"]) || !record(metrics) ||
      !exactKeys(metrics, ["snapshotSeq", "hostedMs", "serviceMs", "snapshotMs", "evaluationMs", "releaseMs", "cacheHits", "leases"]) ||
      !counter(metrics.snapshotSeq) || !counter(metrics.cacheHits) || !counter(metrics.leases) ||
      !nonnegative(metrics.hostedMs) || !nonnegative(metrics.serviceMs) || !nonnegative(metrics.snapshotMs) ||
      !nonnegative(metrics.evaluationMs) || !nonnegative(metrics.releaseMs)) throw new Error("Invalid read probe result");
  return Object.freeze({kind: "complete", metrics: Object.freeze({
    snapshotSeq: metrics.snapshotSeq, hostedMs: metrics.hostedMs, serviceMs: metrics.serviceMs,
    snapshotMs: metrics.snapshotMs, evaluationMs: metrics.evaluationMs, releaseMs: metrics.releaseMs,
    cacheHits: metrics.cacheHits, leases: metrics.leases,
  })});
}

export function successful(sample: Sample): sample is Readonly<{callerMs: number; result: Readonly<{kind: "complete"; metrics: ProbeMetrics}>}> {
  return "result" in sample && sample.result.kind === "complete";
}

export function transportFailure(error: unknown): "timeout" | "network" | "protocol" {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout";
  if (error instanceof SyntaxError) return "protocol";
  return "network";
}

/** Nearest-rank percentiles. Callers choose the explicit outcome population. */
export function latencyStats(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.some(value => !nonnegative(value))) throw new Error("Invalid latency measurement");
  const quantile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1] ?? null;
  return {count: sorted.length, p50: quantile(.5), p95: quantile(.95), p99: quantile(.99), max: sorted.at(-1) ?? null};
}
