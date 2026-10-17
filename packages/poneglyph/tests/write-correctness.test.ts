import {runInDurableObject, evictDurableObject} from "cloudflare:test";
import {env, exports} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import {shardObjectName, virtualKeyForEntity} from "../src/storage/keys.js";
import {transactionCoordinatorName, treeForKey, LEDGER_OUTCOME_LIMIT} from "../src/storage/forest.js";
import {parseFactBatch} from "../src/domain/fact.js";
import {dispatchInternalTransaction} from "../src/storage/transaction-request.js";
const fact = (entity: string, retraction = false) => ({source: "agent:correctness", entity, field: "wiki:person:status", value: {type: "text", value: "alive"}, retraction});
const post = async (graph: string, txId: string, facts: unknown[]) => {
  const batch = parseFactBatch({txId, facts});
  if (!batch.ok) return Response.json({error: batch.error.message}, {status: 400});
  return dispatchInternalTransaction(env, graph, batch.value);
};
describe("write correctness regressions", () => {
  it("retains exact receipts and payload conflicts after another writer publishes", async () => {
    const graph = `test-${crypto.randomUUID()}`, txId = "correctness:retained", facts = [fact("wiki:person:retained")];
    const first = await post(graph, txId, facts); expect(first.status).toBe(200); const receipt = await first.json();
    expect((await post(graph, "correctness:another", [fact("wiki:person:another")])).status).toBe(200);
    const replay = await post(graph, txId, facts); expect(replay.status).toBe(200); expect(await replay.json()).toEqual(receipt);
    expect((await post(graph, txId, [fact("wiki:person:different")])).status).toBe(409);
    // Held-execution behavior is exercised separately by integrated-storage.
  });
  it("replays committed retractions under synthetic capacity pressure without duplicate growth", async () => {
    const graph = `test-${crypto.randomUUID()}`, entity = "wiki:person:prepare-replay";
    expect((await post(graph, "correctness:assert", [fact(entity)])).status).toBe(200);
    const txId = "correctness:retract", facts = [fact(entity, true)];
    const first = await post(graph, txId, facts); expect(first.status).toBe(200); const receipt = await first.json();
    const root = treeForKey(await virtualKeyForEntity(graph, entity)), shard = env.GRAPH_SHARDS.getByName(shardObjectName(graph, root));
    await runInDurableObject(shard, (_instance, state) => {state.storage.sql.exec("UPDATE shard_accounting SET synthetic_size_bytes = 8_000_000_000 WHERE singleton = 1");});
    const replay = await post(graph, txId, facts); expect(replay.status).toBe(200); expect(await replay.json()).toEqual(receipt);
    expect((await post(graph, txId, [fact(entity)])).status).toBe(409);
    const totals = await runInDurableObject(shard, (_instance, state) => ({
      facts: state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM fact_log").one().count,
      active: state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM active_facts WHERE valid_to_seq IS NULL").one().count,
      values: state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM active_values WHERE valid_to_seq IS NULL").one().count,
    }));
    expect(totals).toEqual({facts: 2, active: 0, values: 0});
  });
  it("preserves a published receipt after actual ledger and participant eviction", async () => {
    const graph = `test-${crypto.randomUUID()}`, entity = "wiki:person:durable-receipt", txId = "correctness:durable", facts = [fact(entity)];
    const first = await post(graph, txId, facts); expect(first.status).toBe(200); const receipt = await first.json();
    await evictDurableObject(env.GRAPH_LEDGERS.getByName(await transactionCoordinatorName(graph, txId)));
    await evictDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, treeForKey(await virtualKeyForEntity(graph, entity)))));
    const replay = await post(graph, txId, facts); expect(replay.status).toBe(200); expect(await replay.json()).toEqual(receipt);
    // Exception during post-publication finalization has its own integrated test.
  });
  it("marks a full pooled outcome allocation non-retryable without raising the graph limit", async () => {
    const graph = `test-${crypto.randomUUID()}`, txId = "correctness:quota-seed";
    expect((await post(graph, txId, [fact("wiki:person:quota")])).status).toBe(200);
    const name = await transactionCoordinatorName(graph, txId), ledger = env.GRAPH_LEDGERS.getByName(name);
    // Explicit metadata-only quota fixture, not delivered-write evidence.
    await runInDurableObject(ledger, (_instance, state) => {
      const columns = state.storage.sql.exec<{name: string}>("PRAGMA table_info(candidate_transactions)").toArray().map(row => row.name);
      expect(columns.every(column => /^[a-z_]+$/.test(column))).toBe(true);
      const select = columns.map(column => column === "tx_id" ? "'quota:' || ids.i" : `original.${column}`).join(", ");
      state.storage.sql.exec(`WITH RECURSIVE ids(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM ids WHERE i < ?)
        INSERT INTO candidate_transactions (${columns.join(", ")}) SELECT ${select}
        FROM ids CROSS JOIN (SELECT * FROM candidate_transactions WHERE tx_id = ?) original`, LEDGER_OUTCOME_LIMIT - 1, txId);
    });
    let next: string | undefined;
    for (let i = 0; i < 1000 && !next; i++) {const id = `correctness:quota-new-${i}`; if (await transactionCoordinatorName(graph, id) === name) next = id;}
    if (!next) throw new Error("bounded same-bucket fixture search failed");
    const rejected = await post(graph, next, [fact("wiki:person:quota-new")]); expect(rejected.status).toBe(429); expect(await rejected.json()).toMatchObject({retryable: false});
    const total = await runInDurableObject(ledger, (_instance, state) => state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM candidate_transactions").one().count);
    expect(total).toBe(LEDGER_OUTCOME_LIMIT);
  });
});
