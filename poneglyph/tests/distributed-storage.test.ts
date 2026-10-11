import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isRecord } from "../src/domain/result.js";
import { coordinatorObjectName, shardIndexForEntity, shardObjectName } from "../src/storage/keys.js";
import { parseFactBatch } from "../src/domain/fact.js";
import { canonicalBatchJson, sha256Hex } from "../src/storage/http.js";

type InputFact = Readonly<{
  source: string;
  entity: string;
  field: string;
  value: Readonly<{ type: "text"; value: string }>;
  retraction: boolean;
}>;

type TestBatch = Readonly<{ txId: string; facts: readonly InputFact[] }>;
type TransactionMetadata = Readonly<{
  payload_hash: string;
  statement_time_ms: number;
  commit_seq: number;
}>;

function graphId(): string {
  return `test-${crypto.randomUUID()}`;
}

function transactionId(): string {
  return `poneglyph:tx:${crypto.randomUUID()}`;
}

function fact(entity: string, value: string, retraction = false): InputFact {
  return Object.freeze({
    source: "agent:one-piece-test",
    entity,
    field: "wiki:person:status",
    value: Object.freeze({ type: "text", value }),
    retraction,
  });
}

function differentShardEntities(): readonly [string, string] {
  const first = "wiki:person:shard-test-0";
  const firstShard = shardIndexForEntity(first);
  for (let index = 1; index < 100; index += 1) {
    const next = `wiki:person:shard-test-${index}`;
    if (shardIndexForEntity(next) !== firstShard) return [first, next];
  }
  throw new Error("could not find two entities on distinct fixed leaves");
}

async function invokeWorker(graph: string, action: string, method: string, body?: unknown): Promise<Response> {
  const url = `https://poneglyph.test/v1/graphs/${graph}/${action}`;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const request = new Request(url, init);
  return exports.default.fetch(request);
}

async function postBatch(graph: string, batch: TestBatch): Promise<Response> {
  return invokeWorker(graph, "transactions", "POST", batch);
}

async function query(graph: string, source: string): Promise<Record<string, unknown>> {
  const response = await invokeWorker(graph, "query", "POST", { query: source });
  expect(response.status).toBe(200);
  const result: unknown = await response.json();
  if (!isRecord(result)) throw new Error("expected a query response object");
  return result;
}

function rows(response: Record<string, unknown>): readonly Record<string, unknown>[] {
  const result = response["rows"];
  if (!Array.isArray(result) || !result.every(isRecord)) throw new Error("expected query rows");
  return result;
}

function stringBindings(response: Record<string, unknown>, variable: string): string[] {
  return rows(response).map((row) => {
    const value = row[variable];
    if (!isRecord(value) || value["type"] !== "string" || typeof value["value"] !== "string") {
      throw new Error(`expected string binding for ${variable}`);
    }
    return value["value"];
  }).sort();
}

describe("sharded Durable Object storage protocol", () => {
  it("commits one txId across leaves, streams a fan-out query, and returns idempotent outcomes", async () => {
    const graph = graphId();
    const [entityA, entityB] = differentShardEntities();
    const batch: TestBatch = {
      txId: transactionId(),
      facts: [fact(entityA, "old-a"), fact(entityB, "old-b")],
    };
    expect(shardIndexForEntity(entityA)).not.toBe(shardIndexForEntity(entityB));

    const committed = await postBatch(graph, batch);
    expect(committed.status).toBe(200);
    expect(await committed.json()).toMatchObject({ txId: batch.txId, commitSeq: 1, status: "committed" });

    const result = await query(graph, "wiki:person:status(Person, Status)");
    expect(rows(result)).toHaveLength(2);
    expect(result["snapshotSeq"]).toBe(1);
    expect(result["metrics"]).toMatchObject({ scanCalls: 1, shardRequests: 4, tuplesRead: 2 });

    const retry = await postBatch(graph, batch);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ txId: batch.txId, commitSeq: 1, status: "committed" });

    const conflictingRetry = await postBatch(graph, {
      ...batch,
      facts: [fact(entityA, "different-payload"), fact(entityB, "old-b")],
    });
    expect(conflictingRetry.status).toBe(409);
    expect(rows(await query(graph, 'wiki:person:status(Person, "old-a")'))).toHaveLength(1);

    const entityResponse = await invokeWorker(graph, "entities?uri=" + encodeURIComponent(entityA), "GET");
    expect(entityResponse.status).toBe(200);
    const entityResult: unknown = await entityResponse.json();
    if (!isRecord(entityResult) || !isRecord(entityResult["entity"])) throw new Error("expected a projected entity");
    expect(entityResult["entity"]["lastProcessedTxId"]).toBe(batch.txId);
    expect(entityResult["entity"]["fields"]).toMatchObject({ "wiki:person:status": { type: "text", value: "old-a" } });
  });

  it("cancels prepared participants when a retraction is invalid on one shard", async () => {
    const graph = graphId();
    const [entityA, entityB] = differentShardEntities();
    const baseline: TestBatch = { txId: transactionId(), facts: [fact(entityA, "old-a")] };
    expect((await postBatch(graph, baseline)).status).toBe(200);

    const rejectedBatch: TestBatch = {
      txId: transactionId(),
      facts: [fact(entityA, "old-a", true), fact(entityB, "missing", true)],
    };
    expect(shardIndexForEntity(entityA)).not.toBe(shardIndexForEntity(entityB));
    const rejected = await postBatch(graph, rejectedBatch);
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({ txId: rejectedBatch.txId, status: "aborted" });
    expect(stringBindings(await query(graph, "wiki:person:status(Person, Status)"), "Status")).toEqual(["old-a"]);

    const retry = await postBatch(graph, rejectedBatch);
    expect(retry.status).toBe(409);
  });

  it("keeps snapshot readers on the old graph while one shard has applied a multi-shard tx, then recovers it", async () => {
    const graph = graphId();
    const [entityA, entityB] = differentShardEntities();
    const baseline: TestBatch = {
      txId: transactionId(),
      facts: [fact(entityA, "old-a"), fact(entityB, "old-b")],
    };
    expect((await postBatch(graph, baseline)).status).toBe(200);

    const coordinator = env.GRAPH_COORDINATORS.getByName(coordinatorObjectName(graph));
    const retentionLeaseId = `test-retain-${crypto.randomUUID()}`;
    await runInDurableObject(coordinator, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO graph_read_leases (read_id, snapshot_seq, expires_at_ms) VALUES (?, 1, ?)",
        retentionLeaseId,
        Date.now() + 60_000,
      );
    });

    const update: TestBatch = {
      txId: transactionId(),
      facts: [
        fact(entityA, "old-a", true), fact(entityA, "new-a"),
        fact(entityB, "old-b", true), fact(entityB, "new-b"),
      ],
    };
    expect((await postBatch(graph, update)).status).toBe(200);

    const metadata = await runInDurableObject(coordinator, (_instance, state) => {
      const transaction = state.storage.sql.exec<TransactionMetadata>(
        `SELECT payload_hash, statement_time_ms, commit_seq FROM graph_transactions WHERE tx_id = ?`,
        update.txId,
      ).one();
      return transaction;
    });
    expect(metadata.commit_seq).toBe(2);

    const canonical = parseFactBatch(update);
    if (!canonical.ok) throw new Error(canonical.error.message);
    expect(await sha256Hex(canonicalBatchJson(canonical.value))).toBe(metadata.payload_hash);

    const indexedByShard = new Map<number, { index: number; fact: InputFact }[]>();
    for (const [index, item] of update.facts.entries()) {
      const shard = shardIndexForEntity(item.entity);
      const indexed = indexedByShard.get(shard) ?? [];
      indexed.push({ index, fact: item });
      indexedByShard.set(shard, indexed);
    }
    expect(indexedByShard.size).toBe(2);
    const participantIndices = [...indexedByShard.keys()].sort((left, right) => left - right);
    const unappliedShard = participantIndices[1];
    if (unappliedShard === undefined) throw new Error("expected two participants");
    const participantFacts = indexedByShard.get(unappliedShard);
    if (participantFacts === undefined) throw new Error("participant batch is missing");
    const stagedPayload = JSON.stringify({
      graphId: graph,
      shardIndex: unappliedShard,
      txId: update.txId,
      payloadHash: metadata.payload_hash,
      statementTimeMs: metadata.statement_time_ms,
      commitSeq: metadata.commit_seq,
      facts: participantFacts,
    });

    const unappliedShardStub = env.GRAPH_SHARDS.getByName(shardObjectName(graph, unappliedShard));
    await runInDurableObject(unappliedShardStub, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("DELETE FROM fact_log WHERE tx_id = ?", update.txId);
        state.storage.sql.exec("DELETE FROM active_values WHERE tx_id = ?", update.txId);
        state.storage.sql.exec("DELETE FROM active_facts WHERE tx_id = ?", update.txId);
        state.storage.sql.exec("DELETE FROM entity_versions WHERE last_tx_id = ?", update.txId);
        state.storage.sql.exec(
          "UPDATE active_values SET valid_to_seq = NULL WHERE tx_id = ? AND valid_to_seq = ?",
          baseline.txId,
          metadata.commit_seq,
        );
        state.storage.sql.exec(
          "UPDATE active_facts SET valid_to_seq = NULL WHERE tx_id = ? AND valid_to_seq = ?",
          baseline.txId,
          metadata.commit_seq,
        );
        state.storage.sql.exec(
          "UPDATE entity_versions SET valid_to_seq = NULL WHERE last_tx_id = ? AND valid_to_seq = ?",
          baseline.txId,
          metadata.commit_seq,
        );
        state.storage.sql.exec(
          `UPDATE shard_transactions SET status = 'prepared', payload_json = ?
           WHERE tx_id = ? AND payload_hash = ?`,
          stagedPayload,
          update.txId,
          metadata.payload_hash,
        );
      });
    });

    await runInDurableObject(coordinator, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec(
          "UPDATE graph_state SET visible_seq = ?, writer_tx_id = ? WHERE singleton = 1",
          metadata.commit_seq - 1,
          update.txId,
        );
        state.storage.sql.exec(
          "UPDATE graph_transactions SET phase = 'committing' WHERE tx_id = ?",
          update.txId,
        );
      });
    });

    const duringRecoveryOld = await query(graph, "wiki:person:status(Person, Status)");
    const duringRecoveryNew = await query(graph, 'wiki:person:status(Person, "new-a")');
    expect(duringRecoveryOld["snapshotSeq"]).toBe(1);
    expect(stringBindings(duringRecoveryOld, "Status")).toEqual(["old-a", "old-b"]);
    expect(rows(duringRecoveryNew)).toHaveLength(0);

    await runInDurableObject(coordinator, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM graph_read_leases WHERE read_id = ?", retentionLeaseId);
    });

    const recovered = await postBatch(graph, update);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ txId: update.txId, commitSeq: 2, status: "committed" });

    const afterRecoveryOld = await query(graph, 'wiki:person:status(Person, "old-a")');
    const afterRecoveryNew = await query(graph, "wiki:person:status(Person, Status)");
    expect(afterRecoveryOld["snapshotSeq"]).toBe(2);
    expect(rows(afterRecoveryOld)).toHaveLength(0);
    expect(stringBindings(afterRecoveryNew, "Status")).toEqual(["new-a", "new-b"]);

    for (const entity of [entityA, entityB]) {
      const response = await invokeWorker(graph, `entities?uri=${encodeURIComponent(entity)}`, "GET");
      const entityResult: unknown = await response.json();
      if (!isRecord(entityResult) || !isRecord(entityResult["entity"])) throw new Error("expected an entity projection after recovery");
      expect(entityResult["entity"]["fields"]).toMatchObject({ "wiki:person:status": { type: "text", value: entity === entityA ? "new-a" : "new-b" } });
    }
  });
});
