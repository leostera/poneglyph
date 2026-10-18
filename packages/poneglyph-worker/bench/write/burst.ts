export async function settledBurst<T, R>(inputs: readonly T[], invoke: (input: T) => Promise<R>) {
  const started = performance.now();
  let inFlight = 0, observedMaximumCallerInFlight = 0;
  const calls = inputs.map(async input => {
    inFlight++; observedMaximumCallerInFlight = Math.max(observedMaximumCallerInFlight, inFlight);
    try { return await invoke(input); }
    finally { inFlight--; }
  });
  const launchSpanMs = performance.now() - started;
  const outcomes = await Promise.allSettled(calls);
  if (inFlight !== 0 || outcomes.length !== inputs.length) throw new Error("Incomplete burst drain");
  return {outcomes, observedMaximumCallerInFlight, launchSpanMs, elapsedMs: performance.now() - started};
}
