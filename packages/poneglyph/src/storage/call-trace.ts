// Test-only visibility into Durable Object calls. Production never installs a
// trace array, so this is one global lookup per call.
declare global { var __poneglyphCallTrace: string[] | undefined; }

export function traceCall(object: string, request: Request): void {
  const trace = globalThis.__poneglyphCallTrace;
  if (trace !== undefined) trace.push(`${object} ${new URL(request.url).pathname}`);
}
