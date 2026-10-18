import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { QueryResult } from "../src/client.js";
import { transactionCoordinatorName, treeForKey } from "../src/storage/forest.js";
import { coordinatorObjectName, shardObjectName, virtualKeyForEntity, type VirtualPrefix } from "../src/storage/keys.js";
import { auditFactStorage } from "../src/testing/storage-audit.js";

const RUN_TRAFFIC = (env as unknown as { PONEGLYPH_RUN_TRAFFIC?: string }).PONEGLYPH_RUN_TRAFFIC === "1";
const LOW = {name: "low", transactions: 24, concurrency: 1};
const HIGH = {name: "high", transactions: 1_000, concurrency: 32};
const FIELD = "traffic:correctness";

type Operation = Readonly<{index: number; token: string; entity: string; value: string}>;
type Receipt = Readonly<{txId: string}>;
type Observation = Readonly<{Entity: {type: string; value: string}; Value: {type: string; value: string}}>;

describe.skipIf(!RUN_TRAFFIC)("local traffic correctness", () => {
  it("preserves every write, replay and query result under low sequential traffic", async () => {
    await checkTraffic(LOW);
  }, 120_000);

  it("preserves every write, acknowledged read and durable fact under a high-concurrency burst", async () => {
    await checkTraffic(HIGH);
  }, 180_000);
});

async function checkTraffic(workload: typeof LOW): Promise<void> {
  const graph = `traffic-${workload.name}-${crypto.randomUUID()}`;
  const operations: Operation[] = Array.from({length: workload.transactions}, (_, index) => ({
    index,
    token: `local-traffic:${workload.name}:${index}`,
    entity: `local-traffic:${workload.name}:entity:${index}`,
    value: `value:${index}`,
  }));
  const expected = new Map(operations.map(operation => [operation.entity, operation.value]));
  const acknowledged = new Set<string>();
  const receipts = new Map<number, Receipt>();
  let retryCount = 0;
  let next = 0;

  const writers = Array.from({length: Math.min(workload.concurrency, operations.length)}, async () => {
    while (true) {
      const index = next++;
      const operation = operations[index];
      if (operation === undefined) return;
      const {receipt, retries} = await writeWithRetry(graph, operation);
      expect(receipt.txId).toMatch(/^poneglyph:tx:/);
      receipts.set(index, receipt);
      acknowledged.add(operation.entity);
      retryCount += retries;
    }
  });

  // Concurrent public reads must be complete at their pinned cut: every write
  // acknowledged before a read starts is visible, and every returned row is an
  // exact member of this workload. In-flight commits may also be visible.
  const readers = workload.concurrency === 1 ? [] : Array.from({length: 8}, async (_, index) => {
    await delay(index * 3);
    const acknowledgedBeforeRead = new Set(acknowledged);
    const rows = await queryWithRetry(graph);
    assertRowsAreKnown(rows, expected);
    const visible = new Set(rows.map(row => row.Entity.value));
    for (const entity of acknowledgedBeforeRead) expect(visible, `read omitted acknowledged entity ${entity}`).toContain(entity);
  });

  await Promise.all([...writers, ...readers]);
  expect(receipts.size).toBe(workload.transactions);
  expect(new Set([...receipts.values()].map(receipt => receipt.txId)).size).toBe(workload.transactions);

  const finalRows = await queryWithRetry(graph);
  expect(finalRows).toHaveLength(workload.transactions);
  expect(finalRows.map(row => [row.Entity.value, row.Value.value]).sort(comparePair))
    .toEqual([...expected].map(([entity, value]) => [entity, value]).sort(comparePair));

  // Exercise payload-bound idempotency after the traffic wave, including after
  // evicting the facade and sampled transaction actors from local workerd.
  const replayIndices = [0, Math.floor(workload.transactions / 2), workload.transactions - 1];
  await evictDurableObject(env.GRAPH_FACADES.getByName(coordinatorObjectName(graph)));
  for (const index of new Set(replayIndices)) {
    const operation = operations[index]!;
    const prior = receipts.get(index)!;
    const txCoordinator = env.GRAPH_LEDGERS.getByName(await transactionCoordinatorName(graph, prior.txId));
    await evictDurableObject(txCoordinator);
    expect(await writeWithRetry(graph, operation)).toMatchObject({receipt: prior});
  }
  expect(await queryWithRetry(graph)).toEqual(finalRows);

  // Compare the independent public result with each touched leaf's durable
  // projection audit. The SQL checks are read-only and never repair state.
  const byOwner = new Map<VirtualPrefix, number>();
  for (const operation of operations) {
    const owner = treeForKey(await virtualKeyForEntity(graph, operation.entity));
    byOwner.set(owner, (byOwner.get(owner) ?? 0) + 1);
  }
  let durableFacts = 0;
  for (const [owner, count] of byOwner) {
    const shard = env.GRAPH_SHARDS.getByName(shardObjectName(graph, owner));
    const audit = await runInDurableObject(shard, (_instance, state) => auditFactStorage(state.storage, 0));
    expect(audit.identity[0]).toMatchObject({role: "leaf", prefix: owner});
    expect(audit.active?.[0]?.["count"]).toBe(count);
    expect(audit.mismatchedFacts?.[0]?.["count"]).toBe(0);
    expect(audit.mismatchedValues?.[0]?.["count"]).toBe(0);
    expect(audit.missingValues?.[0]?.["count"]).toBe(0);
    expect(audit.orphanValues?.[0]?.["count"]).toBe(0);
    expect(audit.statuses?.some(row => row["status"] === "prepared")).not.toBe(true);
    durableFacts += Number(audit.active?.[0]?.["count"] ?? 0);
  }
  expect(durableFacts).toBe(workload.transactions);

  console.log(JSON.stringify({
    localRuntime: "workerd (Miniflare)",
    workload: {name: workload.name, transactions: workload.transactions, concurrency: workload.concurrency,
      committed: receipts.size, retryCount, concurrentReadSamples: readers.length, durableFacts},
    scope: "correctness and local actor reconstruction only; not a production capacity or latency claim",
  }));
}

async function writeWithRetry(graph: string, operation: Operation): Promise<Readonly<{receipt: Receipt; retries: number}>> {
  const body = JSON.stringify({clientRequestToken: operation.token, facts: [{source: "fixture:local-traffic",
    entity: operation.entity, field: FIELD, value: {type: "text", value: operation.value}, retraction: false}]});
  for (let attempt = 0; attempt < 32; attempt++) {
    const response = await exports.default.fetch(new Request(`https://database.test/v1/graphs/${graph}/transactions`, {
      method: "POST", headers: {"content-type": "application/json"}, body,
    }));
    const text = await response.text();
    if (response.ok) {
      const result: unknown = JSON.parse(text);
      expect(result).toMatchObject({txId: expect.any(String)});
      expect(Object.keys(result as object)).toEqual(["txId"]);
      return {receipt: result as Receipt, retries: attempt};
    }
    let value: unknown;
    try {value = JSON.parse(text);} catch {throw new Error(`write failed (${response.status}) with non-JSON response: ${text}`);}
    if ((response.status !== 423 && response.status !== 503) || !isRecord(value) || value["retryable"] !== true) {
      throw new Error(`write failed (${response.status}): ${text}`);
    }
    await delay(Math.min(2 + attempt, 25));
  }
  throw new Error(`write ${operation.token} remained retryable after bounded exact-payload replay`);
}

async function queryWithRetry(graph: string): Promise<readonly Observation[]> {
  for (let attempt = 0; attempt < 16; attempt++) {
    const response = await exports.default.fetch(new Request(`https://database.test/v1/graphs/${graph}/query`, {
      method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({query: `${FIELD}(Entity, Value)`}),
    }));
    const text = await response.text();
    if (response.ok) {
      const result = JSON.parse(text) as QueryResult;
      expect(result.snapshotSeq).toBeGreaterThanOrEqual(0);
      expect(result.metrics.tuplesRead).toBeGreaterThanOrEqual(result.rows.length);
      return result.rows as readonly Observation[];
    }
    let value: unknown;
    try {value = JSON.parse(text);} catch {throw new Error(`query failed (${response.status}) with non-JSON response: ${text}`);}
    if (response.status !== 503 || !isRecord(value) || value["retryable"] !== true) {
      throw new Error(`query failed (${response.status}): ${text}`);
    }
    await delay(Math.min(2 + attempt, 20));
  }
  throw new Error("query remained retryable after bounded read retry");
}

function assertRowsAreKnown(rows: readonly Observation[], expected: ReadonlyMap<string, string>): void {
  const seen = new Set<string>();
  for (const row of rows) {
    expect(row.Entity).toMatchObject({type: "string"});
    expect(row.Value).toMatchObject({type: "string"});
    expect(expected.get(row.Entity.value)).toBe(row.Value.value);
    expect(seen.has(row.Entity.value), `duplicate entity ${row.Entity.value}`).toBe(false);
    seen.add(row.Entity.value);
  }
}

function comparePair(left: readonly string[], right: readonly string[]): number {
  return left[0]!.localeCompare(right[0]!) || left[1]!.localeCompare(right[1]!);
}
function delay(ms: number): Promise<void> {return new Promise(resolve => setTimeout(resolve, ms));}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
