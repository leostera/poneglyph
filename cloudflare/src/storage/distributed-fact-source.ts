import type { FactLookup, FactSource, FactTuple } from "../datalog/fact-source.js";
import { parseUri } from "../domain/identifiers.js";
import type { GraphId } from "../domain/graph-id.js";
import { isRecord } from "../domain/result.js";
import { parseDatalogValue } from "../datalog/value.js";
import {
  MAX_QUERY_SCAN_BYTES,
  MAX_QUERY_SHARD_REQUESTS,
  MAX_QUERY_TUPLES,
  MAX_TRANSACTION_BYTES,
  SHARD_COUNT,
} from "./constants.js";
import { shardIndexForEntity, shardObjectName } from "./keys.js";

export type QueryMetrics = {
  scanCalls: number;
  shardRequests: number;
  tuplesRead: number;
  bytesRead: number;
};

export class DistributedFactSource implements FactSource {
  constructor(
    private readonly env: Env,
    private readonly graphId: GraphId,
    private readonly snapshotSeq: number,
    private readonly leaseExpiresAtMs: number,
    readonly metrics: QueryMetrics = { scanCalls: 0, shardRequests: 0, tuplesRead: 0, bytesRead: 0 },
  ) {}

  async *scan(lookup: FactLookup, signal?: AbortSignal): AsyncGenerator<FactTuple> {
    const shardIndices = this.targetShards(lookup);
    if (shardIndices === undefined) return;
    this.metrics.scanCalls += 1;
    this.metrics.shardRequests += shardIndices.length;
    if (this.metrics.shardRequests > MAX_QUERY_SHARD_REQUESTS) {
      throw new QueryScanBudgetExceeded("query shard-request budget exceeded");
    }

    const opened = await Promise.allSettled(shardIndices.map(async (shardIndex) => {
      const stub = this.env.GRAPH_SHARDS.getByName(shardObjectName(this.graphId, shardIndex));
      const body: Record<string, unknown> = {
        graphId: this.graphId,
        shardIndex,
        field: lookup.field,
        snapshotSeq: this.snapshotSeq,
        leaseExpiresAtMs: this.leaseExpiresAtMs,
      };
      if (lookup.entity !== undefined) body["entity"] = lookup.entity;
      if (lookup.value !== undefined) body["value"] = lookup.value;

      const init: RequestInit = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      };
      if (signal !== undefined) init.signal = signal;
      const response = await stub.fetch("https://shard.internal/_scan", init);
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`shard ${shardIndex} scan failed (${response.status}): ${detail.slice(0, 512)}`);
      }
      if (response.body === null) throw new Error(`shard ${shardIndex} returned no scan stream`);
      return { shardIndex, body: response.body };
    }));

    const responses: { shardIndex: number; body: ReadableStream<Uint8Array> }[] = [];
    let openFailure: unknown;
    let failedToOpen = false;
    for (const result of opened) {
      if (result.status === "fulfilled") responses.push(result.value);
      else if (!failedToOpen) {
        openFailure = result.reason;
        failedToOpen = true;
      }
    }
    if (failedToOpen) {
      await Promise.all(responses.map(async ({ body }) => {
        try {
          await body.cancel();
        } catch {
          // Closing partially opened scans is best-effort after a sibling fails.
        }
      }));
      throw openFailure;
    }

    const iterators = responses.map(({ body }) => readTupleStream(body, this.metrics, signal)[Symbol.asyncIterator]());
    const pending = new Map<number, Promise<Readonly<{ index: number; next: IteratorResult<FactTuple> }>>>();
    for (const [index, iterator] of iterators.entries()) {
      pending.set(index, iterator.next().then((next) => ({ index, next })));
    }

    try {
      while (pending.size > 0) {
        const { index, next } = await Promise.race(pending.values());
        pending.delete(index);
        if (next.done) continue;
        yield next.value;
        const iterator = iterators[index];
        if (iterator !== undefined) pending.set(index, iterator.next().then((result) => ({ index, next: result })));
      }
    } finally {
      await Promise.all(iterators.map(async (iterator) => {
        try {
          await iterator.return?.(undefined);
        } catch {
          // Closing sibling streams is best-effort after a query limit or upstream failure.
        }
      }));
    }
  }

  private targetShards(lookup: FactLookup): readonly number[] | undefined {
    if (lookup.entity === undefined) return Array.from({ length: SHARD_COUNT }, (_, index) => index);
    if (lookup.entity.type !== "string") return undefined;
    const entity = parseUri(lookup.entity.value);
    return entity.ok ? [shardIndexForEntity(entity.value)] : undefined;
  }
}

async function* readTupleStream(
  body: ReadableStream<Uint8Array>,
  metrics: QueryMetrics,
  signal: AbortSignal | undefined,
): AsyncGenerator<FactTuple> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let finished = false;

  try {
    while (true) {
      if (signal?.aborted) throw abortError(signal);
      const chunk = await reader.read();
      if (chunk.done) {
        finished = true;
        buffered += decoder.decode();
        if (buffered.length > 0) yield parseTupleLine(buffered, metrics);
        return;
      }

      metrics.bytesRead += chunk.value.byteLength;
      if (metrics.bytesRead > MAX_QUERY_SCAN_BYTES) throw new QueryScanBudgetExceeded("query scan byte budget exceeded");
      buffered += decoder.decode(chunk.value, { stream: true });
      if (buffered.length > MAX_TRANSACTION_BYTES && !buffered.includes("\n")) {
        throw new QueryScanBudgetExceeded("a shard emitted a tuple larger than the row budget");
      }

      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) yield parseTupleLine(line, metrics);
      }
    }
  } finally {
    if (!finished) {
      try {
        await reader.cancel();
      } catch {
        // The producing Durable Object may already have closed its stream.
      }
    }
    reader.releaseLock();
  }
}

function parseTupleLine(line: string, metrics: QueryMetrics): FactTuple {
  let input: unknown;
  try {
    input = JSON.parse(line) as unknown;
  } catch {
    throw new Error("shard emitted invalid NDJSON");
  }
  if (!isRecord(input)) throw new Error("shard emitted an invalid fact tuple");
  const entity = parseUri(input["entity"], "tuple.entity");
  const value = parseDatalogValue(input["value"], "tuple.value");
  if (!entity.ok || !value.ok) throw new Error("shard emitted an invalid fact tuple");
  metrics.tuplesRead += 1;
  if (metrics.tuplesRead > MAX_QUERY_TUPLES) throw new QueryScanBudgetExceeded("query tuple budget exceeded");
  return Object.freeze({
    entity: Object.freeze({ type: "string", value: entity.value }),
    value: value.value,
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Query aborted", "AbortError");
}

export class QueryScanBudgetExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryScanBudgetExceeded";
  }
}
