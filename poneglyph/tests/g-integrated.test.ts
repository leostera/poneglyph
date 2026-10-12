import { runInDurableObject, evictDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as selected from "../src/database-implementation.js";
import * as candidate from "../src/storage-g/implementation.js";
import { treeForKey, treeCoordinatorName, transactionCoordinatorName } from "../src/storage-g/forest.js";
import { virtualKeyForEntity, shardObjectName } from "../src/storage-g/keys.js";
import { auditFactStorage } from "../src/testing/storage-audit.js";

const fact = (entity: string, retraction = false, value = "alive") => ({source: "agent:integrated", entity,
  field: "wiki:person:status", value: {type: "text", value}, retraction});
function write(graph: string, txId: string, facts: unknown[]) {
  return exports.default.fetch(new Request(`https://database.test/v1/graphs/${graph}/transactions`, {method: "POST", body: JSON.stringify({txId, facts})}));
}
async function writeStatus(graph: string, txId: string, facts: unknown[]) {
  const response = await write(graph, txId, facts); const body = await response.text();
  return {status: response.status, body};
}
function query(graph: string) {
  return exports.default.fetch(new Request(`https://database.test/v1/graphs/${graph}/query`, {
    method: "POST", body: JSON.stringify({query: "wiki:person:status(Person, Status)"}),
  }));
}
async function fixtures(graph: string) {
  const first = "wiki:person:integrated-first", root = treeForKey(await virtualKeyForEntity(graph, first));
  let same = "", other = "";
  for (let i = 0; !same || !other; i++) {
    const entity = `wiki:person:integrated-${i}`, next = treeForKey(await virtualKeyForEntity(graph, entity));
    if (next === root) same = entity; else other = entity;
  }
  return {first, same, other, root, otherRoot: treeForKey(await virtualKeyForEntity(graph, other))};
}

describe.runIf(Object.is(selected.GraphCoordinatorDO, candidate.GraphCoordinatorDO))("G integrated authority", () => {
  it("atomically commits complete single-leaf mutations and payload-bound replay", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, same, root} = await fixtures(graph), id = "integrated:atomic";
    expect(await writeStatus(graph, id, [fact(first), fact(same)])).toMatchObject({status: 200});
    expect(await writeStatus(graph, id, [fact(first), fact(same)])).toMatchObject({status: 200});
    expect(await writeStatus(graph, id, [fact(first, false, "changed")])).toMatchObject({status: 409});
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT status, decision_kind, atomic_fact_count, owner_released FROM shard_transactions").one())
        .toMatchObject({status: "committed", decision_kind: "atomic", atomic_fact_count: 2, owner_released: 1});
      expect(auditFactStorage(state.storage, 0).facts).toHaveLength(2);
    });
    const read = await query(graph); expect(read.status).toBe(200);
    expect((await read.json() as {rows: unknown[]}).rows).toHaveLength(2);
    expect(await writeStatus(graph, "integrated:retract", [fact(first, true), fact(same, true)])).toMatchObject({status: 200});
    const empty = await query(graph); expect((await empty.json() as {rows: unknown[]}).rows).toHaveLength(0);
  });

  it("uses pooled distributed authority and owner-local publication for multiple leaves", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, other, root, otherRoot} = await fixtures(graph), id = "integrated:distributed";
    expect(await writeStatus(graph, id, [fact(first), fact(other)])).toMatchObject({status: 200});
    await runInDurableObject(env.GRAPH_COORDINATORS.getByName(await transactionCoordinatorName(graph, id)), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT phase, participant_witness, local_witness_json FROM candidate_transactions WHERE tx_id = ?", id).one())
        .toMatchObject({phase: "complete", participant_witness: 1, local_witness_json: null});
      expect(state.storage.sql.exec("SELECT * FROM ledger_context").toArray()).toHaveLength(1);
      const row = state.storage.sql.exec<{plan_json: string}>("SELECT plan_json FROM candidate_transactions WHERE tx_id = ?", id).one();
      expect(row.plan_json).not.toContain('"fact":');
    });
    for (const owner of [root, otherRoot]) {
      await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, owner)), (_instance, state) => {
        expect(state.storage.sql.exec("SELECT status, decision_kind, owner_released, reserved_mutation_bytes FROM shard_transactions").one())
          .toMatchObject({status: "committed", decision_kind: "distributed", owner_released: 1, reserved_mutation_bytes: 0});
        expect(auditFactStorage(state.storage, 0).facts).toHaveLength(1);
      });
      await runInDurableObject(env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph, owner)), (_instance, state) => {
        expect(state.storage.sql.exec("SELECT phase FROM tree_reservations").one()).toMatchObject({phase: "complete"});
        expect(state.storage.sql.exec("SELECT * FROM entity_write_locks").toArray()).toHaveLength(0);
      });
    }
    const read = await query(graph); expect(read.status).toBe(200); expect((await read.json() as {rows: unknown[]}).rows).toHaveLength(2);
  });

  it("records authoritative atomic abort and releases all owner fences", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, root} = await fixtures(graph), id = "integrated:invalid-retraction";
    expect(await writeStatus(graph, id, [fact(first, true)])).toMatchObject({status: 422});
    expect(await writeStatus(graph, id, [fact(first, true)])).toMatchObject({status: 422});
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT status, decision_kind, owner_released FROM shard_transactions").one())
        .toMatchObject({status: "cancelled", decision_kind: "atomic", owner_released: 1});
      expect(auditFactStorage(state.storage, 0).facts).toHaveLength(0);
    });
    const read = await query(graph); expect(read.status).toBe(200); await read.text();
  });

  it("recovers a lost local decision after real ledger/leaf eviction without duplicate facts", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, root} = await fixtures(graph), id = "integrated:lost-atomic";
    const leaf = env.GRAPH_SHARDS.getByName(shardObjectName(graph, root));
    await runInDurableObject(leaf, async (instance, state) => {
      const atomic = Reflect.get(instance, "atomic");
      Reflect.set(instance, "atomic", async (...args: unknown[]) => {const reply = await atomic.apply(instance, args); await reply.text(); return new Response("lost", {status: 503});});
      try {expect(await writeStatus(graph, id, [fact(first)])).toMatchObject({status: 503});}
      finally {Reflect.set(instance, "atomic", atomic);}
      expect(state.storage.sql.exec("SELECT owner_released FROM shard_transactions").one()).toMatchObject({owner_released: 0});
    });
    const busy = await query(graph); expect(busy.status).toBe(423); await busy.text();
    await evictDurableObject(env.GRAPH_COORDINATORS.getByName(await transactionCoordinatorName(graph, id)));
    await evictDurableObject(leaf);
    expect(await writeStatus(graph, id, [fact(first)])).toMatchObject({status: 200});
    await runInDurableObject(leaf, (_instance, state) => expect(auditFactStorage(state.storage, 0).facts).toHaveLength(1));
  });
});
