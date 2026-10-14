export const SCENARIOS = [
  { name: "parallel-medium", batchSize: 100, concurrency: 10 },
  { name: "parallel-small", batchSize: 10, concurrency: 100 },
  { name: "highly-concurrent", batchSize: 10, concurrency: 1000 },
  { name: "saturation", batchSize: 2, concurrency: 10000 },
] as const;
export type Scenario = { readonly name: string; readonly batchSize: number; readonly concurrency: number };

export function integerOption(value: string | undefined, fallback: number, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new Error(`expected integer in 1..${max}, got ${value}`);
  return result;
}
export function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (q: number) => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] ?? null;
  return { count: sorted.length, meanMs: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    p50Ms: percentile(0.5), p95Ms: sorted.length >= 1000 ? percentile(0.95) : null,
    p99Ms: sorted.length >= 10000 ? percentile(0.99) : null, maxMs: sorted.at(-1) ?? null,
    method: "nearest rank; p95 requires 1,000 and p99 10,000 samples" };
}
