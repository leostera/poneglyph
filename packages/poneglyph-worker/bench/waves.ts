import type {ReadPhase} from "./plan.js";

export type TimedOutcome<Value> = Readonly<{elapsedMs: number}> & (
  | Readonly<{status: "fulfilled"; value: Value}>
  | Readonly<{status: "rejected"}>
);

/** Drain the entire wave even if a callback unexpectedly rejects. No retries. */
export async function settledWaves<Value>(
  phase: ReadPhase,
  call: (index: number) => Promise<Value>,
  keepGoing: (wave: readonly TimedOutcome<Value>[]) => boolean,
) {
  if (!Number.isSafeInteger(phase.count) || phase.count < 1 || !Number.isSafeInteger(phase.concurrency) || phase.concurrency < 1) {
    throw new Error("Expected positive integer scheduling bounds");
  }
  const outcomes: TimedOutcome<Value>[] = [];
  let active = 0, observedMaxInFlight = 0;
  for (let offset = 0; offset < phase.count; offset += phase.concurrency) {
    const count = Math.min(phase.concurrency, phase.count - offset), elapsed: number[] = [];
    const settled = await Promise.allSettled(Array.from({length: count}, async (_, index) => {
      const started = performance.now();
      active++; observedMaxInFlight = Math.max(observedMaxInFlight, active);
      try { return await call(offset + index); }
      finally { elapsed[index] = performance.now() - started; active--; }
    }));
    const wave = settled.map((result, index): TimedOutcome<Value> => result.status === "fulfilled"
      ? {status: "fulfilled", value: result.value, elapsedMs: elapsed[index]!}
      : {status: "rejected", elapsedMs: elapsed[index]!});
    outcomes.push(...wave);
    if (!keepGoing(wave)) break;
  }
  if (active !== 0 || observedMaxInFlight < 1 || observedMaxInFlight > Math.min(phase.count, phase.concurrency)) throw new Error("Concurrency accounting failed");
  return {outcomes, observedMaxInFlight};
}
