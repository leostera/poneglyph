import type { FactLookup, FactSource, FactTuple, FactValueSetLookup } from "../datalog/fact-source.js";
import type { DatalogValue } from "../datalog/value.js";
import type { QueryTiming } from "../domain/query-timing.js";
import type { StorageEnv as Env } from "./environment.js";
import { treeForKey, type TreeSnapshot } from "./forest.js";
import { virtualKeyForEntity } from "./keys.js";
import { parseUri } from "../domain/identifiers.js";
import type { GraphId } from "../domain/graph-id.js";
import { readTupleStream, QueryScanBudgetExceeded } from "../datalog/scan-stream.js";
import {
  MAX_QUERY_SCAN_BYTES,
  MAX_QUERY_SHARD_REQUESTS,
  MAX_QUERY_TUPLES,
  MAX_QUERY_SHARD_FANOUT,
  MAX_QUERY_DIRECTORY_NODES,
  MAX_QUERY_VALUE_SET_SIZE,
  MAX_SQL_BINDINGS,
  MAX_TRANSACTION_BYTES,
} from "./constants.js";
import { shardObjectName } from "./keys.js";
import { listShardLeaves, resolveEntityLeaf, type LeafAddress } from "./routing.js";
import { valueIndexKeysForDatalogValue } from "./value-index.js";

const MAX_VALUE_SET_JSON_BYTES = 13_000;

export type QueryMetrics = {
  scanCalls: number;
  shardRequests: number;
  distinctShardsTouched: number;
  treeReadLeaseAcquisitions: number;
  tuplesRead: number;
  bytesRead: number;
  directoryRequests: number;
  cacheHits: number;
  timing?: QueryTiming;
};

export class DistributedFactSource implements FactSource {
  constructor(
    private readonly env: Env,
    private readonly graphId: GraphId,
    private readonly cut: readonly TreeSnapshot[],
    readonly metrics: QueryMetrics = { scanCalls: 0, shardRequests: 0, distinctShardsTouched: 0, treeReadLeaseAcquisitions: cut.length, tuplesRead: 0, bytesRead: 0, directoryRequests: 0, cacheHits: 0 },
  ) {}

  private allLeaves: readonly LeafAddress[] | undefined;
  private readonly entityRoutes = new Map<string, LeafAddress>();
  private readonly touchedShards = new Set<string>();

  scan(lookup: FactLookup, signal?: AbortSignal): AsyncIterable<FactTuple> {
    return this.scanShards(lookup, undefined, signal);
  }

  scanEntityJoin(lookup: FactLookup, outputField: FactLookup["field"], signal?: AbortSignal): AsyncIterable<FactTuple> {
    return this.scanShards(lookup, outputField, signal);
  }

  scanValues(lookup: FactValueSetLookup, signal?: AbortSignal): AsyncIterable<FactTuple> {
    return this.scanValueSets(lookup, signal);
  }

  private async *scanValueSets(lookup: FactValueSetLookup, signal?: AbortSignal): AsyncGenerator<FactTuple> {
    const encoder = new TextEncoder();
    const batchable: DatalogValue[] = [];
    for (const value of distinctValues(lookup.values)) {
      if (encoder.encode(JSON.stringify([value])).byteLength + 2 > MAX_VALUE_SET_JSON_BYTES) {
        // Preserve the original single-value request path for unusually large
        // values; the shard's existing request-body limit remains authoritative.
        yield* this.scanShards({field: lookup.field, value}, undefined, signal);
      } else {
        batchable.push(value);
      }
    }
    for (const values of partitionValueSets(batchable)) {
      yield* this.scanShards({field: lookup.field}, undefined, signal, values);
    }
  }

  private async *scanShards(
    lookup: FactLookup,
    outputField: FactLookup["field"] | undefined,
    signal?: AbortSignal,
    values?: readonly DatalogValue[],
  ): AsyncGenerator<FactTuple> {
    const shardAddresses = await this.targetShards(lookup);
    if (shardAddresses === undefined) return;
    this.metrics.scanCalls += 1;
    this.metrics.shardRequests += shardAddresses.length;
    for (const address of shardAddresses) this.touchedShards.add(`${address.prefix}:${address.generation}`);
    this.metrics.distinctShardsTouched = this.touchedShards.size;
    if (this.metrics.shardRequests > MAX_QUERY_SHARD_REQUESTS) {
      throw new QueryScanBudgetExceeded("query shard-request budget exceeded");
    }

    const opened = await Promise.allSettled(shardAddresses.map(async (address) => {
      const stub = this.env.GRAPH_SHARDS.getByName(shardObjectName(this.graphId, address.prefix));
      const snapshot = this.cut.find(s => address.prefix.startsWith(s.prefix));
      if (!snapshot) throw new Error("leaf has no leased subtree snapshot");
      const body: Record<string, unknown> = {
        graphId: this.graphId,
        shardPrefix: address.prefix,
        shardGeneration: address.generation,
        directoryEpoch: snapshot.directoryEpoch,
        field: lookup.field,
        snapshotSeq: snapshot.snapshotSeq,
        leaseExpiresAtMs: snapshot.expiresAtMs,
      };
      if (lookup.entity !== undefined) body["entity"] = lookup.entity;
      if (lookup.value !== undefined) body["value"] = lookup.value;
      if (values !== undefined) body["values"] = values;
      if (outputField !== undefined) body["joinField"] = outputField;

      const init: RequestInit = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      };
      if (signal !== undefined) init.signal = signal;
      const response = await stub.fetch("https://shard.internal/_scan", init);
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`shard ${address.prefix} scan failed (${response.status}): ${detail.slice(0, 512)}`);
      }
      if (response.body === null) throw new Error(`shard ${address.prefix} returned no scan stream`);
      return { shardPrefix: address.prefix, body: response.body };
    }));

    const responses = opened.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    const failure = opened.find(result => result.status === "rejected");
    if (failure !== undefined) {
      // Drain every open attempt, then close successful siblings even if one
      // cancellation fails. A rejection with an undefined reason is still failure.
      await Promise.allSettled(responses.map(async ({body}) => body.cancel()));
      throw failure.reason;
    }

    const iterators = responses.map(({ body }) => readTupleStream(body, this.metrics, {maxBytes: MAX_QUERY_SCAN_BYTES, maxTuples: MAX_QUERY_TUPLES, maxRowBytes: MAX_TRANSACTION_BYTES}, signal)[Symbol.asyncIterator]());
    const pending = new Map<number, Promise<Readonly<{ index: number; next: IteratorResult<FactTuple> }>>>();
    for (const [index, iterator] of iterators.entries()) {
      pending.set(index, iterator.next().then((next) => ({ index, next })));
    }

    try {
      while (pending.size > 0) {
        const { index, next } = await Promise.race(pending.values());
        pending.delete(index);
        if (next.done) continue;
        const address = shardAddresses[index];
        if (address && next.value.entity.type === "string") this.entityRoutes.set(next.value.entity.value, address);
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

  private async targetShards(lookup: FactLookup): Promise<readonly LeafAddress[] | undefined> {
    if (lookup.entity === undefined) {
      if (this.allLeaves === undefined) {
        const listings = await Promise.all(this.cut.map(s => listShardLeaves(this.env, this.graphId, s.directoryEpoch, s.prefix)));
        const hops = listings.reduce((n, x) => n + x.directoryHops, 0);
        const leaves = listings.flatMap(x => x.leaves);
        if (hops > MAX_QUERY_DIRECTORY_NODES || leaves.length > MAX_QUERY_SHARD_FANOUT) throw new QueryScanBudgetExceeded("forest query traversal budget exceeded");
        this.metrics.directoryRequests += hops;
        this.allLeaves = leaves;
      }
      return this.allLeaves;
    }
    if (lookup.entity.type !== "string") return undefined;
    const entity = parseUri(lookup.entity.value);
    if (!entity.ok) return undefined;
    const cached = this.entityRoutes.get(entity.value);
    if (cached !== undefined) return [cached];
    const tree = treeForKey(await virtualKeyForEntity(this.graphId, entity.value));
    const snapshot = this.cut.find(s => s.prefix === tree);
    if (!snapshot) throw new Error("entity has no subtree snapshot");
    const route = await resolveEntityLeaf(this.env, this.graphId, entity.value, snapshot.directoryEpoch);
    this.metrics.directoryRequests += route.directoryHops;
    this.entityRoutes.set(entity.value, route.address);
    return [route.address];
  }
}

function distinctValues(input: readonly DatalogValue[]): readonly DatalogValue[] {
  const unique: DatalogValue[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    const key = JSON.stringify([value.type, value.value]);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  return unique;
}

function* partitionValueSets(input: readonly DatalogValue[]): Generator<readonly DatalogValue[]> {
  const encoder = new TextEncoder();
  let values: DatalogValue[] = [];
  let sqlBindings = 3;
  let jsonBytes = 2;
  for (const value of input) {
    const valueBindings = valueIndexKeysForDatalogValue(value).length + 2;
    if (3 + valueBindings > MAX_SQL_BINDINGS) throw new QueryScanBudgetExceeded("query value-set SQL binding budget exceeded");
    const itemBytes = encoder.encode(JSON.stringify(value)).byteLength;
    const nextJsonBytes = jsonBytes + (values.length === 0 ? 0 : 1) + itemBytes;
    if (values.length > 0 && (
      values.length >= MAX_QUERY_VALUE_SET_SIZE ||
      sqlBindings + valueBindings > MAX_SQL_BINDINGS ||
      nextJsonBytes > MAX_VALUE_SET_JSON_BYTES
    )) {
      yield Object.freeze(values);
      values = [];
      sqlBindings = 3;
      jsonBytes = 2;
    }
    const itemJsonBytes = jsonBytes + (values.length === 0 ? 0 : 1) + itemBytes;
    if (itemJsonBytes > MAX_VALUE_SET_JSON_BYTES) throw new QueryScanBudgetExceeded("query value-set request byte budget exceeded");
    values.push(value);
    sqlBindings += valueBindings;
    jsonBytes = itemJsonBytes;
  }
  if (values.length > 0) yield Object.freeze(values);
}
