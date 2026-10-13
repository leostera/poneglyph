import {describe, it, expect} from "vitest";
import {readTupleStream, scanCompletionLine, QueryScanBudgetExceeded, type ScanMetrics, type ScanLimits} from "../src/datalog/scan-stream.js";
const tuple = '{"entity":"test:a","value":{"type":"string","value":"海"}}\n';
const complete = '{"type":"scan-complete","tuples":1}\n';
const limits: ScanLimits = {maxBytes: 4096, maxTuples: 10, maxRowBytes: 1024};
const metrics = (): ScanMetrics => ({bytesRead: 0, tuplesRead: 0});
function body(text: string) {return new Response(text).body!;}
async function collect(text: string, budget = limits, counts = metrics()) {
  return consume(readTupleStream(body(text), counts, budget));
}
async function consume<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}
describe("completed internal shard scans", () => {
  it("requires explicit matching completion and counts only tuples", async () => {
    const counts = metrics();
    expect(await collect(tuple + complete, limits, counts)).toEqual([{entity: {type: "string", value: "test:a"}, value: {type: "string", value: "海"}}]);
    expect(counts.tuplesRead).toBe(1); expect(counts.bytesRead).toBe(new TextEncoder().encode(tuple + complete).byteLength);
    expect(scanCompletionLine(1)).toBe(complete);
  });
  it("certifies an empty scan only with an explicit zero terminal", async () => {
    expect(await collect('{"type":"scan-complete","tuples":0}\n')).toEqual([]);
    await expect(collect("")).rejects.toThrow(/without completion/);
  });
  it("rejects clean EOF at a tuple boundary", async () => {
    await expect(collect(tuple)).rejects.toThrow(/without completion/);
  });
  it("rejects dropped or duplicated tuples via completion counts", async () => {
    await expect(collect(complete)).rejects.toThrow(/count mismatch/);
    await expect(collect(tuple + tuple + complete)).rejects.toThrow(/count mismatch/);
  });
  it("rejects a second terminal or data after the terminal", async () => {
    await expect(collect(tuple + complete + complete)).rejects.toThrow(/after scan completion/);
    await expect(collect(tuple + complete + tuple)).rejects.toThrow(/after scan completion/);
  });
  it("parses arbitrary byte chunk boundaries, including split UTF-8", async () => {
    const bytes = new TextEncoder().encode(tuple + complete);
    const stream = new ReadableStream<Uint8Array>({start(controller) {for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close();}});
    expect(await consume(readTupleStream(stream, metrics(), limits))).toHaveLength(1);
  });
  it("rejects malformed frames, completions and invalid UTF-8", async () => {
    for (const frame of ['not JSON\n', '{"type":"scan-complete","tuples":-1}\n', '{"type":"scan-complete","tuples":0.5}\n', '{"type":"scan-complete","tuples":0,"extra":true}\n', '{"entity":"not a URI","value":{"type":"string","value":"x"}}\n']) {
      await expect(collect(frame)).rejects.toThrow();
    }
    const stream = new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(new Uint8Array([0xc0, 0xaf])); controller.close();}});
    await expect(consume(readTupleStream(stream, metrics(), limits))).rejects.toThrow();
    expect(() => scanCompletionLine(-1)).toThrow();
  });
  it("preserves aggregate tuple/byte limits across separate shard streams", async () => {
    const counts = metrics(), budget = {...limits, maxTuples: 1};
    await collect(tuple + complete, budget, counts);
    await expect(collect(tuple + complete, budget, counts)).rejects.toBeInstanceOf(QueryScanBudgetExceeded);
    const length = new TextEncoder().encode(tuple + complete).byteLength;
    await expect(collect(tuple + complete, {...limits, maxBytes: length})).resolves.toHaveLength(1);
    await expect(collect(tuple + complete, {...limits, maxBytes: length - 1})).rejects.toBeInstanceOf(QueryScanBudgetExceeded);
  });
  it("enforces the row budget even when an oversized frame contains a newline", async () => {
    await expect(collect(tuple + complete, {...limits, maxRowBytes: 10})).rejects.toBeInstanceOf(QueryScanBudgetExceeded);
  });
  it("cancels a blocked producer when the query aborts", async () => {
    const controller = new AbortController(); let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({pull() {}, cancel() {cancelled = true;}});
    const pending = consume(readTupleStream(stream, metrics(), limits, controller.signal));
    await Promise.resolve(); controller.abort(new Error("controlled abort"));
    await expect(pending).rejects.toThrow(/controlled abort/); expect(cancelled).toBe(true);
  });
});
