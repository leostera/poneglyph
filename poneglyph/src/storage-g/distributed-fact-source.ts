import type { FactLookup, FactSource, FactTuple } from "../datalog/fact-source.js";
import type { CandidateStorageEnv as Env } from "./environment.js";
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
  MAX_TRANSACTION_BYTES,
} from "./constants.js";
import { shardObjectName } from "./keys.js";
import { listShardLeaves, resolveEntityLeaf, type LeafAddress } from "./routing.js";

export type QueryMetrics = {
  scanCalls: number;
  shardRequests: number;
  tuplesRead: number;
  bytesRead: number;
  directoryRequests: number;
};

export class DistributedFactSource implements FactSource {
  constructor(
    private readonly env: Env,
    private readonly graphId: GraphId,
    private readonly snapshotSeq: number,
    private readonly directoryEpoch: number,
    private readonly leaseExpiresAtMs: number,
    readonly metrics: QueryMetrics = { scanCalls: 0, shardRequests: 0, tuplesRead: 0, bytesRead: 0, directoryRequests: 0 },
    private readonly cut: readonly TreeSnapshot[] = [],
  ) {}

  private allLeaves: readonly LeafAddress[] | undefined;
  private readonly entityRoutes = new Map<string, LeafAddress>();

  async *scan(lookup: FactLookup, signal?: AbortSignal): AsyncGenerator<FactTuple> {
    const shardAddresses = await this.targetShards(lookup);
    if (shardAddresses === undefined) return;
    this.metrics.scanCalls += 1;
    this.metrics.shardRequests += shardAddresses.length;
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

    const responses: { shardPrefix: string; body: ReadableStream<Uint8Array> }[] = [];
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
