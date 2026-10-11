import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as selected from "../src/database-implementation.js";
import * as candidate from "../src/storage-d/implementation.js";
import { treeForKey, treeCoordinatorName, transactionCoordinatorName } from "../src/storage-d/forest.js";
import { bitAt, virtualKeyForEntity, shardObjectName } from "../src/storage-d/keys.js";
import { MAX_ACCOUNTED_BYTES_PER_DO } from "../src/storage-d/constants.js";
import { ensureCoordinatorSchema } from "../src/storage-d/sql.js";

const fact = (entity: string, value = "alive", retraction = false, field = "wiki:person:status") => ({
  source: "agent:d", entity, field, value: {type: "text", value}, retraction,
});
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
async function entities(graph: string) {
  const a = "wiki:person:d-first", key = await virtualKeyForEntity(graph, a), prefix = treeForKey(key);
  let b = "", c = "", splitSibling = "";
  for (let i = 0; (!b || !c || !splitSibling) && i < 2000; i++) {
    const entity = `wiki:person:d-${i}`, otherKey = await virtualKeyForEntity(graph, entity);
    if (treeForKey(otherKey) !== prefix) c = entity;
    else {
      b = entity;
      if (bitAt(otherKey, 4) !== bitAt(key, 4)) splitSibling = entity;
    }
  }
  expect(b && c && splitSibling).toBeTruthy();
  return {a, b, c, splitSibling, prefix};
}
async function assertCleanOwner(graph: string, entity: string) {
  const prefix = treeForKey(await virtualKeyForEntity(graph, entity));
  const response = await env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph, prefix)).fetch("https://owner.internal/_tree-audit", {
    method: "POST", body: JSON.stringify({graphId: graph, prefix}),
  });
  expect(response.status).toBe(200);
  const summary = await response.json() as {entityLockCount: number; ownerTicketAnomalies: number};
  expect(summary.entityLockCount).toBe(0);
  expect(summary.ownerTicketAnomalies).toBe(0);
}

describe.runIf(Object.is(selected.GraphCoordinatorDO, candidate.GraphCoordinatorDO))("D entity conflict protocol", () => {
  it("same-leaf disjoint writes sharing an AV prefix finish while a lower ticket is held; reads and overlaps stay fenced", async () => {
    const graph = `test-${crypto.randomUUID()}`, {a, b, prefix} = await entities(graph), id = "d:held";
    const actor = env.GRAPH_COORDINATORS.getByName(transactionCoordinatorName(graph, id));
    const owner = env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph, prefix));
    const leaf = env.GRAPH_SHARDS.getByName(shardObjectName(graph, prefix));
    await runInDurableObject(actor, async instance => {
      // DO stubs are I/O objects: construct them in the context using them.
      const owner = env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph, prefix));
      const leaf = env.GRAPH_SHARDS.getByName(shardObjectName(graph, prefix));
      const engine = Reflect.get(instance, "transaction"), original = Reflect.get(engine, "participant");
      let release!: () => void, reached!: () => void;
      const gate = new Promise<void>(resolve => {release = resolve;}), arrival = new Promise<void>(resolve => {reached = resolve;});
      Reflect.set(engine, "participant", async (...args: unknown[]) => {
        if (args[2] === "_commit") {reached(); await gate;}
        return original.apply(engine, args);
      });
      const pending = instance.fetch(new Request("https://transaction.internal/_transact", {
        method: "POST", body: JSON.stringify({graphId: graph, batch: {txId: id, facts: [fact(a)]}}),
      }));
      try {
        await arrival;
        expect((await write(graph, "d:disjoint", [fact(b)])).status).toBe(200);
        expect((await write(graph, "d:disjoint", [fact(b)])).status).toBe(200);
        expect((await write(graph, "d:overlap-field", [fact(a, "name", false, "schema:name")])).status).toBe(423);
        expect((await write(graph, id, [fact(b)])).status).toBe(409);
        expect((await query(graph)).status).toBe(423);
        expect((await owner.fetch("https://owner.internal/_tree-split", {method: "POST", body: JSON.stringify({graphId: graph, prefix, sourcePrefix: prefix, force: true})})).status).toBe(423);
        await runInDurableObject(owner, (_instance, state) => {
          expect(state.storage.sql.exec<{visible_seq: number; next_write_seq: number}>("SELECT visible_seq, next_write_seq FROM graph_state").one()).toMatchObject({visible_seq: 2, next_write_seq: 2});
          expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM entity_write_locks").one().count).toBe(1);
        });
        await runInDurableObject(leaf, (_instance, state) => {
          expect(state.storage.sql.exec<{bytes: number}>("SELECT SUM(reserved_mutation_bytes) AS bytes FROM shard_transactions WHERE status = 'prepared'").one().bytes).toBeGreaterThan(0);
        });
      } finally {release(); Reflect.set(engine, "participant", original);}
      expect((await pending).status).toBe(200);
    });
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(2);
    await assertCleanOwner(graph, a);
    await runInDurableObject(owner, (_instance, state) => {
      expect(state.storage.sql.exec<{visible_seq: number}>("SELECT visible_seq FROM graph_state").one().visible_seq).toBe(2);
    });
    await runInDurableObject(leaf, (_instance, state) => {
      expect(state.storage.sql.exec<{bytes: number}>("SELECT SUM(reserved_mutation_bytes) AS bytes FROM shard_transactions").one().bytes).toBe(0);
    });
    expect((await write(graph, "d:overlap-field", [fact(a, "name", false, "schema:name")])).status).toBe(200);
  });

  it("persists different owner tickets for one atomic cross-owner transaction", async () => {
    const graph = `test-${crypto.randomUUID()}`, {a, c} = await entities(graph), id = "d:vector";
    for (let i = 0; i < 5; i++) expect((await write(graph, `d:seed:${i}`, [fact(c, `seed-${i}`, false, "schema:name")])).status).toBe(200);
    expect((await write(graph, id, [fact(a), fact(c)])).status).toBe(200);
    await runInDurableObject(env.GRAPH_COORDINATORS.getByName(transactionCoordinatorName(graph, id)), (_instance, state) => {
      const row = state.storage.sql.exec<{plan_json: string; commit_seq: number}>("SELECT plan_json, commit_seq FROM candidate_transactions").one();
      expect(row.commit_seq).toBe(6);
      expect((JSON.parse(row.plan_json) as {commitSeq: number}[]).map(p => p.commitSeq).sort()).toEqual([1, 6]);
    });
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(2);
    await assertCleanOwner(graph, a); await assertCleanOwner(graph, c);
  });

  it.each(["_prepare", "_commit", "_tree-finish"])("recovers partial %s after eviction without exposing a mixed cut", async action => {
    const graph = `test-${crypto.randomUUID()}`, {a, c} = await entities(graph), id = `d:fault:${action}`;
    const actor = env.GRAPH_COORDINATORS.getByName(transactionCoordinatorName(graph, id));
    await runInDurableObject(actor, async instance => {
      const engine = Reflect.get(instance, "transaction"), method = action === "_tree-finish" ? "tree" : "participant", original = Reflect.get(engine, method);
      let calls = 0;
      Reflect.set(engine, method, async (...args: unknown[]) => {
        if (args[2] === action && calls++ === 1) return new Response("injected partial step", {status: 503});
        return original.apply(engine, args);
      });
      try {
        expect((await instance.fetch(new Request("https://transaction.internal/_transact", {method: "POST",
          body: JSON.stringify({graphId: graph, batch: {txId: id, facts: [fact(a), fact(c)]}})}))).status).toBe(503);
      } finally {Reflect.set(engine, method, original);}
    });
    expect((await query(graph)).status).toBe(423);
    const conflict = await write(graph, id, [fact(a, "changed")]);
    expect(conflict.status).toBe(409);
    // Drain the RPC answer before eviction; an unread body retains its DO.
    await conflict.arrayBuffer();
    if (action === "_tree-finish") {
      // Whichever owner published first may now accept another entity mutation.
      // Repeating the old publication must not roll that owner's watermark back.
      for (const entity of [a, c]) {
        const prefix = treeForKey(await virtualKeyForEntity(graph, entity));
        const owner = env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph, prefix));
        const phase = await runInDurableObject(owner, (_instance, state) => state.storage.sql.exec<{phase: string}>("SELECT phase FROM tree_reservations WHERE tx_id = ?", id).one().phase);
        if (phase === "complete") expect((await write(graph, "d:after-publication", [fact(entity, "later")])).status).toBe(200);
      }
      expect((await query(graph)).status).toBe(423);
    }
    await evictDurableObject(actor);
    expect((await write(graph, id, [fact(a), fact(c)])).status).toBe(200);
    expect((await write(graph, id, [fact(a), fact(c)])).status).toBe(200);
    const result = await (await query(graph)).json() as {rows: {Status: {value: string}}[]};
    expect(result.rows).toHaveLength(action === "_tree-finish" ? 3 : 2);
    if (action === "_tree-finish") expect(result.rows.some(row => row.Status.value === "later")).toBe(true);
    await assertCleanOwner(graph, a); await assertCleanOwner(graph, c);
  }, 60_000);

  it("cancels an invalid cross-owner retraction and releases only its complete entity set", async () => {
    const graph = `test-${crypto.randomUUID()}`, {a, c} = await entities(graph);
    expect((await write(graph, "d:cancel-seed", [fact(a), fact(c)])).status).toBe(200);
    expect((await write(graph, "d:invalid", [fact(a, "changed"), fact(c, "missing", true)])).status).toBe(422);
    const result = await (await query(graph)).json() as {rows: {Status: {value: string}}[]};
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every(row => row.Status.value === "alive")).toBe(true);
    await assertCleanOwner(graph, a); await assertCleanOwner(graph, c);
    expect((await write(graph, "d:retract", [fact(a, "alive", true)])).status).toBe(200);
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(1);
  });

  it("replays a discarded receipt after eviction without rebinding identity to a different owner", async () => {
    const graph = `test-${crypto.randomUUID()}`, {a, c} = await entities(graph), id = "d:lost";
    const committed = await write(graph, id, [fact(a)]);
    expect(committed.status).toBe(200); await committed.body?.cancel();
    await evictDurableObject(env.GRAPH_COORDINATORS.getByName(transactionCoordinatorName(graph, id)));
    expect((await write(graph, id, [fact(a)])).status).toBe(200);
    expect((await write(graph, id, [fact(c)])).status).toBe(409);
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(1);
  });

  it("resumes interrupted splits while other owners progress", async () => {
    const graph = `test-${crypto.randomUUID()}`, {a, c, splitSibling, prefix} = await entities(graph);
    expect((await write(graph, "d:split-seed", [fact(a), fact(splitSibling)])).status).toBe(200);
    const facade = env.GRAPH_COORDINATORS.getByName(candidate.coordinatorObjectName(graph));
    expect((await facade.fetch("https://graph.internal/_split", {method: "POST", body: JSON.stringify({graphId: graph, prefix, force: true, stopAfterPages: 1})})).status).toBe(503);
    expect((await write(graph, "d:split-other", [fact(c)])).status).toBe(200);
    expect((await query(graph)).status).toBe(423);
    expect((await facade.fetch("https://graph.internal/_split", {method: "POST", body: JSON.stringify({graphId: graph, prefix, force: true})})).status).toBe(200);
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(3);
  });

  it("fences writers with a read lease and releases an expired lease", async () => {
    const graph = `test-${crypto.randomUUID()}`, {a, prefix} = await entities(graph);
    expect((await write(graph, "d:lease-seed", [fact(a)])).status).toBe(200);
    const owner = env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph, prefix));
    const lease = await owner.fetch("https://owner.internal/_tree-read", {method: "POST", body: JSON.stringify({graphId: graph, prefix})});
    expect(lease.status).toBe(200);
    const body = await lease.json() as {readId: string};
    expect((await write(graph, "d:lease-write", [fact(a, "later")])).status).toBe(423);
    await runInDurableObject(owner, (_instance, state) => {state.storage.sql.exec("UPDATE graph_read_leases SET expires_at_ms = 0 WHERE read_id = ?", body.readId);});
    expect((await write(graph, "d:lease-write", [fact(a, "later")])).status).toBe(200);
  });

  it("accounts prepared future growth before admitting another disjoint participant under synthetic pressure", async () => {
    const graph = `test-${crypto.randomUUID()}`, {a, b, prefix} = await entities(graph);
    const leaf = env.GRAPH_SHARDS.getByName(shardObjectName(graph, prefix));
    const participant = async (id: string, entity: string, seq: number) => ({graphId: graph, shardPrefix: prefix, shardGeneration: 0, directoryEpoch: 0,
      txId: id, payloadHash: "1".repeat(64), commitSeq: seq, statementTimeMs: Date.now(),
      facts: [{index: 0, virtualKey: await virtualKeyForEntity(graph, entity), fact: fact(entity, "x".repeat(400_000))}]});
    const first = await participant("d:capacity-a", a, 1), second = await participant("d:capacity-b", b, 2);
    expect((await leaf.fetch("https://leaf.internal/_prepare", {method: "POST", body: JSON.stringify(first)})).status).toBe(200);
    await runInDurableObject(leaf, (instance, state) => {
      const growth = state.storage.sql.exec<{reserved_mutation_bytes: number}>("SELECT reserved_mutation_bytes FROM shard_transactions WHERE tx_id = ?", first.txId).one().reserved_mutation_bytes;
      expect(growth).toBeGreaterThan(0);
      const capacity = Reflect.get(instance, "capacityFor");
      // Synthetic accounting only: locate a boundary where one future delta
      // fits, but the already prepared delta plus another does not.
      state.storage.sql.exec("UPDATE shard_transactions SET reserved_mutation_bytes = 0 WHERE tx_id = ?", first.txId);
      let low = 0, high = MAX_ACCOUNTED_BYTES_PER_DO;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        state.storage.sql.exec("UPDATE shard_accounting SET synthetic_size_bytes = ?", mid);
        if (capacity.call(instance, [second.facts[0]!.fact]).canAdmit) low = mid; else high = mid - 1;
      }
      state.storage.sql.exec("UPDATE shard_accounting SET synthetic_size_bytes = ?", low - Math.floor(growth / 2));
      expect(capacity.call(instance, [second.facts[0]!.fact]).canAdmit).toBe(true);
      state.storage.sql.exec("UPDATE shard_transactions SET reserved_mutation_bytes = ? WHERE tx_id = ?", growth, first.txId);
      expect(capacity.call(instance, [second.facts[0]!.fact]).canAdmit).toBe(false);
    });
    expect((await leaf.fetch("https://leaf.internal/_prepare", {method: "POST", body: JSON.stringify(first)})).status).toBe(200);
    expect((await leaf.fetch("https://leaf.internal/_preflight", {method: "POST", body: JSON.stringify(first)})).status).toBe(200);
    expect((await leaf.fetch("https://leaf.internal/_prepare", {method: "POST", body: JSON.stringify(second)})).status).toBe(413);
    expect((await leaf.fetch("https://leaf.internal/_cancel", {method: "POST", body: JSON.stringify({...first, facts: undefined})})).status).toBe(200);
    await runInDurableObject(leaf, (_instance, state) => {
      expect(state.storage.sql.exec<{reserved_mutation_bytes: number}>("SELECT reserved_mutation_bytes FROM shard_transactions WHERE tx_id = ?", first.txId).one().reserved_mutation_bytes).toBe(0);
      state.storage.sql.exec("UPDATE shard_accounting SET synthetic_size_bytes = 0");
    });
  });

  it("binds the exact owner entity set and fails closed if a durable lock is missing", async () => {
    const graph = `test-${crypto.randomUUID()}`, {a, b, prefix} = await entities(graph), id = "d:owned-set";
    const actor = env.GRAPH_COORDINATORS.getByName(transactionCoordinatorName(graph, id));
    await runInDurableObject(actor, async instance => {
      const engine = Reflect.get(instance, "transaction"), original = Reflect.get(engine, "participant");
      Reflect.set(engine, "participant", async (...args: unknown[]) => args[2] === "_preflight"
        ? new Response("injected preflight interruption", {status: 503}) : original.apply(engine, args));
      try {
        expect((await instance.fetch(new Request("https://transaction.internal/_transact", {method: "POST",
          body: JSON.stringify({graphId: graph, batch: {txId: id, facts: [fact(a)]}})}))).status).toBe(503);
      } finally {Reflect.set(engine, "participant", original);}
    });
    const owner = env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph, prefix));
    const hash = await runInDurableObject(owner, (_instance, state) => state.storage.sql.exec<{payload_hash: string}>("SELECT payload_hash FROM tree_reservations WHERE tx_id = ?", id).one().payload_hash);
    const changedSet = await owner.fetch("https://owner.internal/_tree-lock", {method: "POST",
      body: JSON.stringify({graphId: graph, prefix, txId: id, payloadHash: hash, entities: [b]})});
    expect(changedSet.status).toBe(409); await changedSet.arrayBuffer();
    // Intentional storage-corruption fixture, not a SUT repair path.
    await runInDurableObject(owner, (_instance, state) => {state.storage.sql.exec("DELETE FROM entity_write_locks WHERE tx_id = ?", id);});
    expect((await query(graph)).status).toBe(423);
    const broken = await write(graph, id, [fact(a)]);
    expect(broken.status).toBe(503); await broken.arrayBuffer();
    await runInDurableObject(owner, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO entity_write_locks (entity, tx_id, payload_hash) VALUES (?, ?, ?)", a, id, hash);
    });
    expect((await write(graph, id, [fact(a)])).status).toBe(200);
    await assertCleanOwner(graph, a);
    expect((await owner.fetch("https://owner.internal/_tree-transaction", {method: "POST",
      body: JSON.stringify({graphId: graph, prefix, batch: {txId: "d:no-coarse-path", facts: [fact(b)]}})})).status).toBe(404);
  });

  it("rejects B1 schema markers without reinterpretation", async () => {
    const owner = env.GRAPH_COORDINATORS.getByName(`d-schema:${crypto.randomUUID()}`);
    await runInDurableObject(owner, (_instance, state) => {
      state.storage.sql.exec("UPDATE poneglyph_schema SET kind = 'candidate-coordinator', version = 2");
      expect(() => ensureCoordinatorSchema(state.storage)).toThrow(/schema/);
      expect(state.storage.sql.exec<{version: number}>("SELECT version FROM poneglyph_schema").one().version).toBe(2);
    });
  });
});
