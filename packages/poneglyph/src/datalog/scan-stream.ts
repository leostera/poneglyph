import type {FactTuple} from "./fact-source.js";
import {parseDatalogValue} from "./value.js";
import {parseUri} from "../domain/identifiers.js";
import {isRecord} from "../domain/result.js";

export type ScanMetrics = {bytesRead: number; tuplesRead: number};
export type ScanLimits = Readonly<{maxBytes: number; maxTuples: number; maxRowBytes: number}>;
type ScanFrame = {kind: "tuple"; tuple: FactTuple} | {kind: "complete"; tuples: number};
type ScanProgress = {kind: "reading"; tuples: number} | {kind: "complete"; tuples: number};

// Completion is an explicit producer statement after SQL exhaustion and lease
// checks, not an inference from transport EOF. This is an internal wire format;
// facts/persistence and the buffered public query API are unchanged.
export function scanCompletionLine(tuples: number): string {
  if (!Number.isSafeInteger(tuples) || tuples < 0) throw new Error("invalid scan completion count");
  return JSON.stringify({type: "scan-complete", tuples}) + "\n";
}
function parseFrame(line: string): ScanFrame {
  const input: unknown = JSON.parse(line);
  if (!isRecord(input)) throw new Error("shard emitted an invalid scan frame");
  if (input["type"] === "scan-complete") {
    const tuples = input["tuples"];
    if (Object.keys(input).length !== 2 || typeof tuples !== "number" || !Number.isSafeInteger(tuples) || tuples < 0) throw new Error("invalid shard scan completion");
    return {kind: "complete", tuples};
  }
  const entity = parseUri(input["entity"], "tuple.entity"), value = parseDatalogValue(input["value"], "tuple.value");
  if (Object.keys(input).length !== 2 || !entity.ok || !value.ok) throw new Error("shard emitted an invalid fact tuple");
  return {kind: "tuple", tuple: Object.freeze({entity: Object.freeze({type: "string", value: entity.value}), value: value.value})};
}
class ScanFrames {
  private progress: ScanProgress = {kind: "reading", tuples: 0};
  private readonly encoder = new TextEncoder();
  constructor(private readonly metrics: ScanMetrics, private readonly limits: ScanLimits) {}
  accept(line: string): FactTuple | undefined {
    if (this.progress.kind === "complete") throw new Error("shard emitted data after scan completion");
    if (this.encoder.encode(line).byteLength > this.limits.maxRowBytes) throw new QueryScanBudgetExceeded("a shard emitted a frame larger than the row budget");
    const frame = parseFrame(line);
    if (frame.kind === "complete") {
      if (frame.tuples !== this.progress.tuples) throw new Error("shard scan completion count mismatch");
      this.progress = {kind: "complete", tuples: frame.tuples};
      return undefined;
    }
    this.metrics.tuplesRead++;
    if (this.metrics.tuplesRead > this.limits.maxTuples) throw new QueryScanBudgetExceeded("query tuple budget exceeded");
    this.progress = {kind: "reading", tuples: this.progress.tuples + 1};
    return frame.tuple;
  }
  finish() {
    if (this.progress.kind !== "complete") throw new Error("shard scan ended without completion evidence");
  }
}
export async function* readTupleStream(body: ReadableStream<Uint8Array>, metrics: ScanMetrics, limits: ScanLimits, signal?: AbortSignal): AsyncGenerator<FactTuple> {
  const reader = body.getReader(), decoder = new TextDecoder("utf-8", {fatal: true});
  const frames = new ScanFrames(metrics, limits), encoder = new TextEncoder();
  let buffered = "", ended = false;
  const abortRead = () => {void reader.cancel(signal?.reason).catch(() => {});};
  signal?.addEventListener("abort", abortRead, {once: true});
  try {
    while (true) {
      throwIfAborted(signal);
      const chunk = await reader.read();
      throwIfAborted(signal);
      if (chunk.done) {
        ended = true; buffered += decoder.decode();
        if (buffered.length) {const tuple = frames.accept(buffered); if (tuple) yield tuple;}
        frames.finish(); return;
      }
      metrics.bytesRead += chunk.value.byteLength;
      if (metrics.bytesRead > limits.maxBytes) throw new QueryScanBudgetExceeded("query scan byte budget exceeded");
      buffered += decoder.decode(chunk.value, {stream: true});
      while (true) {
        const newline = buffered.indexOf("\n"); if (newline < 0) break;
        const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
        const tuple = frames.accept(line); if (tuple) yield tuple;
      }
      if (encoder.encode(buffered).byteLength > limits.maxRowBytes) throw new QueryScanBudgetExceeded("a shard emitted a frame larger than the row budget");
    }
  } finally {
    signal?.removeEventListener("abort", abortRead);
    if (!ended) {try {await reader.cancel();} catch {/* The producer may already have failed. */}}
    reader.releaseLock();
  }
}
function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Query aborted", "AbortError");
}
export class QueryScanBudgetExceeded extends Error {
  constructor(message: string) {super(message); this.name = "QueryScanBudgetExceeded";}
}
