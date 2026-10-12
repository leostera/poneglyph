import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as selected from "../src/database-implementation.js";
import * as candidate from "../src/storage-f/implementation.js";
import { treeForKey, transactionCoordinatorName, treeCoordinatorName } from "../src/storage-f/forest.js";
import { bitAt, virtualKeyForEntity, shardObjectName } from "../src/storage-f/keys.js";
import { MAX_ACCOUNTED_BYTES_PER_DO } from "../src/storage-f/constants.js";
import { ensureCoordinatorSchema } from "../src/storage-f/sql.js";

const fact = (entity: string, retraction = false, value = "alive") => ({ source: "agent:candidate", entity,
  field: "wiki:person:status", value: {type: "text", value}, retraction });
async function entities(graph: string) {
  const found = new Map<string, string>();
  for (let i = 0; found.size < 4 && i < 1000; i++) {
    const entity = `wiki:person:concurrency-${i}`;
    found.set(treeForKey(await virtualKeyForEntity(graph, entity)), entity);
  }
  expect(found.size).toBe(4);
  return [...found.values()];
}
function write(graph: string, txId: string, facts: unknown[]) {
  return exports.default.fetch(new Request(`https://database.test/v1/graphs/${graph}/transactions`, {
    method: "POST", body: JSON.stringify({txId, facts}),
  }));
}
function query(graph: string) {
  return exports.default.fetch(new Request(`https://database.test/v1/graphs/${graph}/query`, {
    method: "POST", body: JSON.stringify({query: "wiki:person:status(Person, Status)"}),
  }));
}
function envelope(graphId: string, txId: string, facts: unknown[]) {
  return new Request("https://transaction.internal/_transact", {method: "POST", body: JSON.stringify({graphId, batch: {txId, facts}})});
}

describe.runIf(Object.is(selected.GraphCoordinatorDO, candidate.GraphCoordinatorDO))("provisional plans and referenced owner staging", () => {
  it("a blocked committing transaction cannot block disjoint owners, but does block overlapping writes and torn reads", async () => {
    const graph = `test-${crypto.randomUUID()}`, [a, b, c, d] = await entities(graph);
    const txId = "candidate:held";
    const transaction = env.GRAPH_COORDINATORS.getByName(transactionCoordinatorName(graph, txId));
    await runInDurableObject(transaction, async instance => {
      const engine = Reflect.get(instance, "transaction");
      const original = Reflect.get(engine, "participant");
      let release!: () => void, reached!: () => void;
      const gate = new Promise<void>(resolve => {release = resolve;}), arrival = new Promise<void>(resolve => {reached = resolve;});
      Reflect.set(engine, "participant", async (...args: unknown[]) => {
        if (args[2] === "_commit") { reached(); await gate; }
        return original.apply(engine, args);
      });
      const pending = instance.fetch(envelope(graph, txId, [fact(a!), fact(b!)]));
      try {
        await arrival;
        expect((await write(graph, "candidate:disjoint", [fact(c!), fact(d!)])).status).toBe(200);
        expect((await write(graph, "candidate:overlap", [fact(a!)])).status).toBe(423);
        expect((await query(graph)).status).toBe(423);
      } finally { release(); Reflect.set(engine, "participant", original); }
      expect((await pending).status).toBe(200);
    });
    expect((await write(graph, "candidate:overlap", [fact(a!)])).status).toBe(200);
    const result = await query(graph);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({rows: expect.any(Array), sequenceScope: "subtree-vector"});
  });

  it("recovers a durable cross-tree decision after partial apply without a duplicate or torn query", async () => {
    const graph = `test-${crypto.randomUUID()}`, [a, b] = await entities(graph), txId = "candidate:recover";
    const transaction = env.GRAPH_COORDINATORS.getByName(transactionCoordinatorName(graph, txId));
    await runInDurableObject(transaction, async instance => {
      const engine = Reflect.get(instance, "transaction"), original = Reflect.get(engine, "participant");
      let failed = false;
      Reflect.set(engine, "participant", async (...args: unknown[]) => {
        if (args[2] === "_commit" && !failed) { failed = true; return new Response("injected failed apply", {status: 503}); }
        return original.apply(engine, args);
      });
      try { expect((await instance.fetch(envelope(graph, txId, [fact(a!), fact(b!) ]))).status).toBe(503); }
      finally { Reflect.set(engine, "participant", original); }
    });
    expect((await query(graph)).status).toBe(423);
    expect((await write(graph, txId, [fact(a!), fact(b!)])).status).toBe(200);
    expect((await write(graph, txId, [fact(a!), fact(b!)])).status).toBe(200);
    const result = await query(graph); expect(result.status).toBe(200);
    expect((await result.json() as {rows: unknown[]}).rows).toHaveLength(2);
    for (const entity of [a!, b!]) {
      const root = treeForKey(await virtualKeyForEntity(graph, entity));
      const leaf = env.GRAPH_SHARDS.getByName(shardObjectName(graph, root));
      await runInDurableObject(leaf, (_instance, state) => {
        expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM fact_log").one().count).toBe(1);
      });
    }
  });

  it("cancels all prepared owners for an invalid cross-tree retraction and binds identity across different roots", async () => {
    const graph = `test-${crypto.randomUUID()}`, [a, b, c] = await entities(graph);
    expect((await write(graph, "candidate:seed", [fact(a!), fact(b!)])).status).toBe(200);
    expect((await write(graph, "candidate:seed", [fact(c!)])).status).toBe(409);
    expect((await write(graph, "candidate:invalid", [fact(a!, false, "changed"), fact(b!, true, "missing")])).status).toBe(422);
    const result = await query(graph); expect(result.status).toBe(200);
    const body = await result.json() as {rows: {Status: {value: string}}[]};
    expect(body.rows).toHaveLength(2); expect(body.rows.every(row => row.Status.value === "alive")).toBe(true);
    expect((await write(graph, "candidate:retract", [fact(a!, true), fact(b!, true)])).status).toBe(200);
    expect((await write(graph, "candidate:retract", [fact(a!, true), fact(b!, true)])).status).toBe(200);
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(0);
  });

  it("recovers interrupted subtree copy while unrelated trees continue writing", async () => {
    const graph = `test-${crypto.randomUUID()}`;
    const first = "wiki:person:split-first", firstKey = await virtualKeyForEntity(graph, first), root = treeForKey(firstKey);
    let second = "", other = "";
    for (let i = 0; !second || !other; i++) {
      const entity = `wiki:person:split-${i}`, key = await virtualKeyForEntity(graph, entity);
      if (treeForKey(key) !== root) other = entity;
      else if (bitAt(key, 4) !== bitAt(firstKey, 4)) second = entity;
    }
    expect((await write(graph, "candidate:split-seed", [fact(first), fact(second)])).status).toBe(200);
    const facade = env.GRAPH_COORDINATORS.getByName(candidate.coordinatorObjectName(graph));
    const split = await facade.fetch("https://graph.internal/_split", {method: "POST", body: JSON.stringify({graphId: graph, prefix: root, force: true, stopAfterPages: 1})});
    expect(split.status).toBe(503);
    expect((await write(graph, "candidate:split-disjoint", [fact(other)])).status).toBe(200);
    expect((await query(graph)).status).toBe(423);
    const resume = await facade.fetch("https://graph.internal/_split", {method: "POST", body: JSON.stringify({graphId: graph, prefix: root, force: true})});
    expect(resume.status).toBe(200);
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(3);
  });

  it("leaves owner gates free during provisional preflight", async () => {
    const graph = `test-${crypto.randomUUID()}`, [a, b] = await entities(graph), id = "f:provisional-held";
    await runInDurableObject(env.GRAPH_COORDINATORS.getByName(transactionCoordinatorName(graph, id)), async instance => {
      const engine = Reflect.get(instance, "transaction"), participant = Reflect.get(engine, "participant");
      let release!: () => void, reached!: () => void, held = false;
      const gate = new Promise<void>(r => {release = r;}), arrival = new Promise<void>(r => {reached = r;});
      Reflect.set(engine, "participant", async (...args: unknown[]) => {
        if (args[2] === "_preflight" && !held) {held = true; reached(); await gate;}
        return participant.apply(engine, args);
      });
      const pending = instance.fetch(envelope(graph, id, [fact(a!), fact(b!)]));
      try {
        await arrival;
        for (const entity of [a!, b!]) {
          const prefix = treeForKey(await virtualKeyForEntity(graph, entity));
          await runInDurableObject(env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph, prefix)), (_root, state) =>
            expect(state.storage.sql.exec("SELECT writer_tx_id FROM graph_state").one()).toMatchObject({writer_tx_id: null}));
        }
        expect((await write(graph, "f:while-planning", [fact(a!, false, "interleaved")])).status).toBe(200);
        expect((await query(graph)).status).toBe(200);
      } finally {release(); Reflect.set(engine, "participant", participant);}
      expect((await pending).status).toBe(200);
    });
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(3);
  });

  it("rejects a split between provisional routing and admission before staging", async () => {
    const graph = `test-${crypto.randomUUID()}`, [a, b] = await entities(graph), id = "f:stale-plan";
    expect((await write(graph, "f:split-seed", [fact(a!)])).status).toBe(200);
    const prefix = treeForKey(await virtualKeyForEntity(graph, a!));
    await runInDurableObject(env.GRAPH_COORDINATORS.getByName(transactionCoordinatorName(graph, id)), async (instance, state) => {
      const engine = Reflect.get(instance, "transaction"), original = Reflect.get(engine, "provisionalPlan");
      Reflect.set(engine, "provisionalPlan", async (...args: unknown[]) => {
        const plan = await original.apply(engine, args);
        const response = await env.GRAPH_COORDINATORS.getByName(candidate.coordinatorObjectName(graph)).fetch("https://graph.internal/_split", {
          method: "POST", body: JSON.stringify({graphId: graph, prefix, force: true}),
        });
        expect(response.status).toBe(200); await response.text();
        return plan;
      });
      try {const response = await instance.fetch(envelope(graph, id, [fact(a!), fact(b!)])); expect(response.status).toBe(423); await response.text();}
      finally {Reflect.set(engine, "provisionalPlan", original);}
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM candidate_transactions").one().count).toBe(0);
    });
    for (const entity of [a!, b!]) {
      const root = treeForKey(await virtualKeyForEntity(graph, entity));
      await runInDurableObject(env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph, root)), (_instance, state) =>
        expect(state.storage.sql.exec("SELECT writer_tx_id FROM graph_state").one()).toMatchObject({writer_tx_id: null}));
    }
    expect((await write(graph, id, [fact(a!), fact(b!)])).status).toBe(200);
    // Query tuples deduplicate identical values; append-only facts still retain
    // both the seed assertion and the acknowledged retry's new assertion.
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(2);
  });

  it("recovers a referenced owner batch after actual owner and journal eviction", async () => {
    const graph = `test-${crypto.randomUUID()}`, [a] = await entities(graph), id = "f:reference", prefix = treeForKey(await virtualKeyForEntity(graph, a!));
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, prefix)), async instance => {
      const original = Reflect.get(instance, "prepare"); Reflect.set(instance, "prepare", () => new Response("interrupted prepare", {status: 503}));
      try {const failed = await write(graph, id, [fact(a!)]); expect(failed.status).toBe(503); await failed.text();}
      finally {Reflect.set(instance, "prepare", original);}
    });
    await runInDurableObject(env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph, prefix)), (_instance, state) =>
      expect(state.storage.sql.exec("SELECT phase, batch_json, batch_reference FROM graph_transactions").one()).toMatchObject({phase: "preparing", batch_json: null, batch_reference: 1}));
    const busy = await query(graph); expect(busy.status).toBe(423); await busy.text();
    await evictDurableObject(env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph, prefix)));
    const journal = env.GRAPH_COORDINATORS.getByName(transactionCoordinatorName(graph, id));
    // It may have naturally evicted while the owner eviction drained; reopen
    // read-only so this explicit eviction also exercises a live journal object.
    await runInDurableObject(journal, (_instance, state) => {expect(state.storage.sql.exec("SELECT phase FROM candidate_transactions").one()).toMatchObject({phase: "preparing"});});
    await evictDurableObject(journal);
    expect((await write(graph, id, [fact(a!)])).status).toBe(200);
    expect((await write(graph, id, [fact(a!)])).status).toBe(200);
    expect((await write(graph, id, [fact(a!, false, "changed")])).status).toBe(409);
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(1);
  });

  it("fails closed on unavailable journal references without losing the owner intent", async () => {
    const graph = `test-${crypto.randomUUID()}`, [a] = await entities(graph), id = "f:journal-unavailable", prefix = treeForKey(await virtualKeyForEntity(graph, a!));
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, prefix)), async instance => {
      const original = Reflect.get(instance, "prepare"); Reflect.set(instance, "prepare", () => new Response("interrupted", {status: 503}));
      try {const failed = await write(graph, id, [fact(a!)]); expect(failed.status).toBe(503); await failed.text();}
      finally {Reflect.set(instance, "prepare", original);}
    });
    await runInDurableObject(env.GRAPH_COORDINATORS.getByName(transactionCoordinatorName(graph, id)), async instance => {
      const engine = Reflect.get(instance, "transaction"), original = Reflect.get(engine, "journal");
      Reflect.set(engine, "journal", () => new Response(JSON.stringify({error: "unavailable"}), {status: 409}));
      try {const failed = await write(graph, id, [fact(a!)]); expect(failed.status).toBe(503); await failed.text();}
      finally {Reflect.set(engine, "journal", original);}
    });
    await runInDurableObject(env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph, prefix)), (_instance, state) =>
      expect(state.storage.sql.exec("SELECT phase, batch_reference FROM graph_transactions").one()).toMatchObject({phase: "preparing", batch_reference: 1}));
    expect((await write(graph, id, [fact(a!)])).status).toBe(200);
  });

  it("reuses hot owner routes instead of regrouping its just-admitted batch", async () => {
    const graph = `test-${crypto.randomUUID()}`, [a] = await entities(graph), prefix = treeForKey(await virtualKeyForEntity(graph, a!));
    await runInDurableObject(env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph, prefix)), async (instance, state) => {
      const original = Reflect.get(instance, "groupBatch"), journal = Reflect.get(instance, "readBatchJournal");
      let groups = 0, payloadReads = 0;
      Reflect.set(instance, "groupBatch", (...args: unknown[]) => {groups++; return original.apply(instance, args);});
      Reflect.set(instance, "readBatchJournal", (...args: unknown[]) => {if (args[2] !== true) payloadReads++; return journal.apply(instance, args);});
      try {expect((await write(graph, "f:hot-owner", [fact(a!)])).status).toBe(200);}
      finally {Reflect.set(instance, "groupBatch", original); Reflect.set(instance, "readBatchJournal", journal);}
      expect(groups).toBe(1); expect(payloadReads).toBe(0);
      expect(state.storage.sql.exec("SELECT batch_json, batch_reference FROM graph_transactions").one()).toMatchObject({batch_json: null, batch_reference: 1});
    });
  });

  it("uses only an exact durable-payload hot leaf cache and clears it after commit", async () => {
    const graph = `test-${crypto.randomUUID()}`, [a] = await entities(graph), prefix = treeForKey(await virtualKeyForEntity(graph, a!));
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, prefix)), async instance => {
      const original = Reflect.get(instance, "decodePrepared"); let decoded = 0;
      Reflect.set(instance, "decodePrepared", (...args: unknown[]) => {
        const cache = Reflect.get(instance, "staged"), result = original.apply(instance, args);
        expect(cache).toBeDefined(); expect(result).toBe(cache.batch); decoded++; return result;
      });
      try {expect((await write(graph, "f:hot-leaf", [fact(a!)])).status).toBe(200);}
      finally {Reflect.set(instance, "decodePrepared", original);}
      expect(decoded).toBe(1); expect(Reflect.get(instance, "staged")).toBeUndefined();
    });
  });

  it("recovers a cold leaf from its durable prepare payload after actual eviction", async () => {
    const graph = `test-${crypto.randomUUID()}`, [a] = await entities(graph), id = "f:cold-leaf", prefix = treeForKey(await virtualKeyForEntity(graph, a!));
    await runInDurableObject(env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph, prefix)), async instance => {
      const original = Reflect.get(instance, "commitParticipant"); Reflect.set(instance, "commitParticipant", () => {throw new Error("injected apply interruption");});
      try {const failed = await write(graph, id, [fact(a!)]); expect(failed.status).toBe(503); await failed.text();}
      finally {Reflect.set(instance, "commitParticipant", original);}
    });
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, prefix)), (_instance, state) =>
      expect(state.storage.sql.exec("SELECT status, payload_json FROM shard_transactions").one()).toMatchObject({status: "prepared", payload_json: expect.any(String)}));
    await evictDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, prefix)));
    expect((await write(graph, id, [fact(a!)])).status).toBe(200);
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(1);
  });

  it.each(["_prepare", "_tree-finish"])("recovers partial %s without replanning admitted routes", async action => {
    const graph = `test-${crypto.randomUUID()}`, [a, b] = await entities(graph), id = `f:partial-${action}`;
    await runInDurableObject(env.GRAPH_COORDINATORS.getByName(transactionCoordinatorName(graph, id)), async instance => {
      const engine = Reflect.get(instance, "transaction"), name = action === "_prepare" ? "participant" : "tree", original = Reflect.get(engine, name);
      let failed = false;
      Reflect.set(engine, name, async (...args: unknown[]) => {
        if (args[2] === action && !failed) {failed = true; return new Response("injected partial failure", {status: 503});}
        return original.apply(engine, args);
      });
      try {const response = await instance.fetch(envelope(graph, id, [fact(a!), fact(b!)])); expect(response.status).toBe(503); await response.text();}
      finally {Reflect.set(engine, name, original);}
      const planner = Reflect.get(engine, "provisionalPlan"); Reflect.set(engine, "provisionalPlan", () => {throw new Error("admitted plan was recomputed");});
      try {expect((await instance.fetch(envelope(graph, id, [fact(a!), fact(b!)]))).status).toBe(200);}
      finally {Reflect.set(engine, "provisionalPlan", planner);}
    });
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(2);
  });

  it("does not use a positive provisional preflight as capacity admission", async () => {
    const graph = `test-${crypto.randomUUID()}`, [a, b] = await entities(graph), id = "f:capacity-changed", prefix = treeForKey(await virtualKeyForEntity(graph, a!));
    await runInDurableObject(env.GRAPH_COORDINATORS.getByName(transactionCoordinatorName(graph, id)), async instance => {
      const engine = Reflect.get(instance, "transaction"), original = Reflect.get(engine, "provisionalPlan");
      Reflect.set(engine, "provisionalPlan", async (...args: unknown[]) => {
        const result = await original.apply(engine, args);
        // Synthetic accounting only, not physical capacity evidence.
        await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, prefix)), (_leaf, state) =>
          state.storage.sql.exec("UPDATE shard_accounting SET synthetic_size_bytes = ?", MAX_ACCOUNTED_BYTES_PER_DO));
        return result;
      });
      try {const response = await instance.fetch(envelope(graph, id, [fact(a!), fact(b!)])); expect(response.status).toBe(422); await response.text();}
      finally {Reflect.set(engine, "provisionalPlan", original);}
    });
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, prefix)), (_instance, state) =>
      state.storage.sql.exec("UPDATE shard_accounting SET synthetic_size_bytes = 0"));
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(0);
    expect((await write(graph, id, [fact(a!), fact(b!)])).status).toBe(422);
  });

  it("releases previously stranded unprepared gates before discarding a retried intent", async () => {
    const graph = `test-${crypto.randomUUID()}`, [a, b] = await entities(graph), id = "f:release-retry";
    await runInDurableObject(env.GRAPH_COORDINATORS.getByName(transactionCoordinatorName(graph, id)), async (instance, state) => {
      const engine = Reflect.get(instance, "transaction"), original = Reflect.get(engine, "tree");
      let mode = 1, locks = 0;
      Reflect.set(engine, "tree", async (...args: unknown[]) => {
        if (args[2] === "_tree-lock") {
          locks++;
          if ((mode === 1 && locks === 2) || mode === 2) return new Response("injected contention", {status: 423});
        }
        if (args[2] === "_tree-unlock" && mode === 1) return new Response("interrupted release", {status: 503});
        return original.apply(engine, args);
      });
      try {
        const first = await instance.fetch(envelope(graph, id, [fact(a!), fact(b!)])); expect(first.status).toBe(503); await first.text();
        expect(state.storage.sql.exec("SELECT phase, plan_json FROM candidate_transactions").one()).toMatchObject({phase: "preparing", plan_json: null});
        mode = 2;
        const retry = await instance.fetch(envelope(graph, id, [fact(a!), fact(b!)])); expect(retry.status).toBe(423); await retry.text();
        expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM candidate_transactions").one().count).toBe(0);
      } finally {Reflect.set(engine, "tree", original);}
    });
    for (const entity of [a!, b!]) {
      const prefix = treeForKey(await virtualKeyForEntity(graph, entity));
      await runInDurableObject(env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph, prefix)), (_instance, state) => {
        expect(state.storage.sql.exec("SELECT writer_tx_id FROM graph_state").one()).toMatchObject({writer_tx_id: null});
      });
    }
    expect((await write(graph, id, [fact(a!), fact(b!)])).status).toBe(200);
  });

  it("rejects B1 owner schema without mutation", async () => {
    const graph = `test-${crypto.randomUUID()}`, [a] = await entities(graph), prefix = treeForKey(await virtualKeyForEntity(graph, a!));
    await runInDurableObject(env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph, prefix)), (_instance, state) => {
      state.storage.sql.exec("UPDATE poneglyph_schema SET kind = 'candidate-coordinator', version = 2");
      expect(() => ensureCoordinatorSchema(state.storage)).toThrow();
      expect(state.storage.sql.exec("SELECT kind, version FROM poneglyph_schema").one()).toMatchObject({kind: "candidate-coordinator", version: 2});
      state.storage.sql.exec("UPDATE poneglyph_schema SET kind = 'f-coordinator', version = 6");
    });
  });

  it("expires a subtree read lease rather than serving a mixed cut", async () => {
    const graph = `test-${crypto.randomUUID()}`, [a] = await entities(graph);
    expect((await write(graph, "candidate:lease-seed", [fact(a!)])).status).toBe(200);
    const prefix = treeForKey(await virtualKeyForEntity(graph, a!));
    const tree = env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph, prefix));
    const lease = await tree.fetch("https://tree.internal/_tree-read", {method: "POST", body: JSON.stringify({graphId: graph, prefix})});
    expect(lease.status).toBe(200);
    const body = await lease.json() as {readId: string};
    expect((await write(graph, "candidate:lease-blocked", [fact(a!, false, "later")])).status).toBe(423);
    await runInDurableObject(tree, (_instance, state) => {
      state.storage.sql.exec("UPDATE graph_read_leases SET expires_at_ms = 0 WHERE read_id = ?", body.readId);
    });
    expect((await write(graph, "candidate:lease-blocked", [fact(a!, false, "later")])).status).toBe(200);
  });
});
