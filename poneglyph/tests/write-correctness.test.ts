import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { coordinatorObjectName, shardObjectName, virtualKeyForEntity, type VirtualPrefix } from "../src/storage/keys.js";
import { MAX_RETAINED_TRANSACTION_OUTCOMES } from "../src/storage/constants.js";

const fact = (entity: string, retraction = false) => ({ source: "agent:correctness", entity, field: "wiki:person:status",
  value: { type: "text", value: "alive" }, retraction });
const request = (graph: string, body: unknown) => new Request(`https://poneglyph.test/v1/graphs/${graph}/transactions`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const post = (graph: string, body: unknown) => exports.default.fetch(request(graph, body));

describe("write correctness regressions", () => {
  it("returns retained receipts and conflicts even while another writer is active", async () => {
    const graph = `test-${crypto.randomUUID()}`;
    const body = { txId: "correctness:retained", facts: [fact("wiki:person:retained")] };
    expect((await post(graph, body)).status).toBe(200);
    const coordinator = env.GRAPH_COORDINATORS.getByName(coordinatorObjectName(graph));
    await runInDurableObject(coordinator, async instance => {
      // Controlled admission barrier; no fake commit or participant writes.
      const prior = Reflect.get(instance, "activeWriterTxId");
      Reflect.set(instance, "activeWriterTxId", "correctness:another-writer");
      try {
        const replay = await instance.fetch(request(graph, body));
        expect(replay.status).toBe(200);
        expect(await replay.json()).toMatchObject({ txId: body.txId, commitSeq: 1, status: "committed" });
        const conflict = await instance.fetch(request(graph, { ...body, facts: [fact("wiki:person:different")] }));
        expect(conflict.status).toBe(409);
        expect((await instance.fetch(request(graph, { ...body, txId: "correctness:new" }))).status).toBe(423);
      } finally { Reflect.set(instance, "activeWriterTxId", prior); }
    });
  });

  it("replays committed participant retractions without revalidating removed facts or reserving capacity again", async () => {
    const graph = `test-${crypto.randomUUID()}`, entity = "wiki:person:prepare-replay";
    expect((await post(graph, { txId: "correctness:assert", facts: [fact(entity)] })).status).toBe(200);
    const txId = "correctness:retract";
    expect((await post(graph, { txId, facts: [fact(entity, true)] })).status).toBe(200);
    const coordinator = env.GRAPH_COORDINATORS.getByName(coordinatorObjectName(graph));
    const meta = await runInDurableObject(coordinator, (_instance, state) => state.storage.sql.exec<{
      payload_hash: string; statement_time_ms: number; commit_seq: number;
    }>("SELECT payload_hash, statement_time_ms, commit_seq FROM graph_transactions WHERE tx_id = ?", txId).one());
    const shard = env.GRAPH_SHARDS.getByName(shardObjectName(graph, "" as VirtualPrefix));
    await runInDurableObject(shard, (_instance, state) => {
      state.storage.sql.exec("UPDATE shard_accounting SET synthetic_size_bytes = 8_000_000_000 WHERE singleton = 1");
    });
    const body = { graphId: graph, shardPrefix: "", shardGeneration: 0, directoryEpoch: 0, txId,
      payloadHash: meta.payload_hash, statementTimeMs: meta.statement_time_ms, commitSeq: meta.commit_seq,
      facts: [{ index: 0, virtualKey: await virtualKeyForEntity(graph, entity), fact: fact(entity, true) }] };
    const replay = await shard.fetch("https://shard.internal/_prepare", { method: "POST", body: JSON.stringify(body) });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ status: "committed" });
    const conflict = await shard.fetch("https://shard.internal/_prepare", { method: "POST", body: JSON.stringify({ ...body, payloadHash: "0".repeat(64) }) });
    expect(conflict.status).toBe(409);
    const totals = await runInDurableObject(shard, (_instance, state) => ({
      facts: state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM fact_log").one().count,
      active: state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM active_facts WHERE valid_to_seq IS NULL").one().count,
      values: state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM active_values WHERE valid_to_seq IS NULL").one().count,
    }));
    expect(totals).toEqual({ facts: 2, active: 0, values: 0 });
  });

  it("does not fail an already published commit when post-commit pruning fails", async () => {
    const graph = `test-${crypto.randomUUID()}`;
    const coordinator = env.GRAPH_COORDINATORS.getByName(coordinatorObjectName(graph));
    await runInDurableObject(coordinator, async instance => {
      const original = Reflect.get(instance, "pruneVersions");
      Reflect.set(instance, "pruneVersions", async () => { throw new Error("injected maintenance failure"); });
      try {
        const body = { txId: "correctness:maintenance", facts: [fact("wiki:person:maintenance")] };
        const committed = await instance.fetch(request(graph, body));
        expect(committed.status).toBe(200);
        expect(await committed.json()).toMatchObject({ txId: body.txId, commitSeq: 1, status: "committed" });
        expect((await instance.fetch(request(graph, body))).status).toBe(200);
      } finally { Reflect.set(instance, "pruneVersions", original); }
    });
  });

  it("marks a full retained-outcome window non-retryable without raising the limit", async () => {
    const graph = `test-${crypto.randomUUID()}`;
    expect((await post(graph, { txId: "correctness:quota-seed", facts: [fact("wiki:person:quota")] })).status).toBe(200);
    const coordinator = env.GRAPH_COORDINATORS.getByName(coordinatorObjectName(graph));
    await runInDurableObject(coordinator, (_instance, state) => {
      state.storage.sql.exec(`WITH RECURSIVE ids(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM ids WHERE i < ?)
        INSERT INTO graph_transactions (tx_id, payload_hash, batch_json, participants_json, directory_epoch, statement_time_ms, commit_seq, phase, created_at_ms)
        SELECT 'quota:' || i, payload_hash, NULL, participants_json, directory_epoch, statement_time_ms, commit_seq, 'complete', created_at_ms
        FROM ids CROSS JOIN (SELECT * FROM graph_transactions WHERE tx_id = 'correctness:quota-seed')`, MAX_RETAINED_TRANSACTION_OUTCOMES - 1);
    });
    const rejected = await post(graph, { txId: "correctness:quota-new", facts: [fact("wiki:person:quota-new")] });
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toMatchObject({ retryable: false });
    const total = await runInDurableObject(coordinator, (_instance, state) => state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM graph_transactions").one().count);
    expect(total).toBe(MAX_RETAINED_TRANSACTION_OUTCOMES);
  });
});
