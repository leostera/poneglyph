// Test-only transport transformations. These never seed/repair SQL or provide
// expected query answers; each is applied to a real successful shard scan.
export const readFaultModes = ["none", "unavailable-before", "malformed", "empty-eof", "record-eof", "record-error"] as const;
export type ReadFaultMode = (typeof readFaultModes)[number];
export function parseReadFaultMode(value: unknown): ReadFaultMode {
  const mode = readFaultModes.find(mode => mode === value);
  if (mode === undefined) throw new Error("unknown read fault mode");
  return mode;
}
export async function transformRead(response: Response, mode: ReadFaultMode): Promise<Response> {
  if (mode === "none" || mode === "unavailable-before") return response;
  if (!response.ok || !response.body) throw new Error("read fault requires a real successful scan body");
  if (mode === "malformed" || mode === "empty-eof") {
    await response.body.cancel();
    return new Response(mode === "malformed" ? "not a JSON tuple\n" : "", {headers: response.headers});
  }
  const line = await firstRecord(response.body);
  let emitted = false;
  return new Response(new ReadableStream<Uint8Array>({pull(controller) {
    if (!emitted) {emitted = true; controller.enqueue(new TextEncoder().encode(line)); return;}
    if (mode === "record-error") controller.error(new Error("injected transport interruption after actual tuple"));
    else controller.close(); // A clean EOF at a record boundary is still partial.
  }}), {headers: response.headers});
}
async function firstRecord(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let prefix = "";
  try {
    while (!prefix.includes("\n")) {
      const next = await reader.read();
      if (next.done) throw new Error("read fault did not encounter an actual tuple");
      prefix += decoder.decode(next.value, {stream: true});
    }
    return prefix.slice(0, prefix.indexOf("\n") + 1);
  } finally {
    // Release the native scan even on source failure; never leave an abandoned
    // reader solely because the fault adapter itself encountered an error.
    try {await reader.cancel();} finally {reader.releaseLock();}
  }
}
