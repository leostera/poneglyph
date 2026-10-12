import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as selected from "../src/database-implementation.js";
import * as candidate from "../src/storage-e/implementation.js";
import { treeForKey, treeCoordinatorName, transactionCoordinatorName } from "../src/storage-e/forest.js";
import { bitAt, parseVirtualPrefix, shardObjectName, virtualKeyForEntity } from "../src/storage-e/keys.js";
import { ensureShardSchema } from "../src/storage-e/sql.js";
import { MAX_ACCOUNTED_BYTES_PER_DO } from "../src/storage-e/constants.js";
import { auditFactStorage } from "../src/testing/storage-audit.js";

const fact = (entity: string, retraction = false, value = "alive") => ({source: "agent:atomic", entity,
  field: "wiki:person:status", value: {type: "text", value}, retraction});
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
async function fixtures(graph: string) {
  const first = "wiki:person:atomic-first", key = await virtualKeyForEntity(graph, first), root = treeForKey(key);
  let second = "", other = "";
  for (let i = 0; !second || !other; i++) {
    const name = `wiki:person:atomic-${i}`, next = await virtualKeyForEntity(graph, name);
    if (treeForKey(next) !== root) other = name;
    else if (bitAt(next, 4) !== bitAt(key, 4)) second = name;
  }
  return {first, second, other, root};
}
async function split(graph: string, prefix: string, stopAfterPages?: number) {
  return env.GRAPH_COORDINATORS.getByName(candidate.coordinatorObjectName(graph)).fetch("https://graph.internal/_split", {
    method: "POST", body: JSON.stringify({graphId: graph, prefix, force: true, stopAfterPages}),
  });
}
function address(graph: string, prefix: string) {
  const parsed = parseVirtualPrefix(prefix);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return shardObjectName(graph, parsed.value);
}
async function leafCount(graph: string, prefix: string) {
  return runInDurableObject(env.GRAPH_SHARDS.getByName(address(graph, prefix)), (_instance, state) =>
    state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM fact_log").one().count);
}

describe.runIf(Object.is(selected.GraphCoordinatorDO, candidate.GraphCoordinatorDO))("payload-bound atomic leaf authority", () => {
  it("commits full facts/indices/projections/outcome without prepare or commit staging", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, second, root} = await fixtures(graph);
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), async instance => {
      const prepare = Reflect.get(instance, "prepare"), commit = Reflect.get(instance, "commit");
      Reflect.set(instance, "prepare", () => {throw new Error("unexpected prepare");});
      Reflect.set(instance, "commit", () => {throw new Error("unexpected commit");});
      try {expect((await write(graph, "atomic:plain", [fact(first), fact(second)])).status).toBe(200);}
      finally {Reflect.set(instance, "prepare", prepare); Reflect.set(instance, "commit", commit);}
    });
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), (instance, state) => {
      expect(state.storage.sql.exec("SELECT status, decision_kind, atomic_fact_count, atomic_published FROM shard_transactions").one())
        .toMatchObject({status: "committed", decision_kind: "atomic", atomic_fact_count: 2, atomic_published: 1});
      const audit = auditFactStorage(state.storage, 0);
      expect(audit.facts).toHaveLength(2);
    });
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(2);
    expect((await write(graph, "atomic:retract", [fact(first, true), fact(second, true)])).status).toBe(200);
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(0);
    expect(await leafCount(graph, root)).toBe(4);
  });

  it("rolls back facts and projections if outcome insertion cannot be reached", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, root} = await fixtures(graph), id = "atomic:rollback";
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), async (instance, state) => {
      const apply = Reflect.get(instance, "applyParticipantBatch");
      Reflect.set(instance, "applyParticipantBatch", (...args: unknown[]) => {apply.apply(instance, args); throw new Error("injected after full application");});
      try {const failed = await write(graph, id, [fact(first)]); expect(failed.status).toBe(503); await failed.text();}
      finally {Reflect.set(instance, "applyParticipantBatch", apply);}
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM fact_log").one().count).toBe(0);
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM entity_versions").one().count).toBe(0);
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM shard_transactions").one().count).toBe(0);
    });
    expect((await query(graph)).status).toBe(423);
    expect((await write(graph, id, [fact(first)])).status).toBe(200);
    expect(await leafCount(graph, root)).toBe(1);
  });

  it("recovers a committed local answer lost before publication after real eviction", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, other, root} = await fixtures(graph), id = "atomic:lost-local";
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), async (instance, state) => {
      const atomic = Reflect.get(instance, "atomic");
      Reflect.set(instance, "atomic", async (...args: unknown[]) => {const answer = await atomic.apply(instance, args); await answer.text(); return new Response("discarded local decision", {status: 503});});
      try {const failed = await write(graph, id, [fact(first)]); expect(failed.status).toBe(503); await failed.text();}
      finally {Reflect.set(instance, "atomic", atomic);}
      expect(state.storage.sql.exec("SELECT status, atomic_published FROM shard_transactions").one()).toMatchObject({status: "committed", atomic_published: 0});
    });
    const busy = await query(graph); expect(busy.status).toBe(423); await busy.text();
    const blockedSplit = await split(graph, root); expect(blockedSplit.status).toBe(423); await blockedSplit.text();
    const disjoint = await write(graph, "atomic:disjoint", [fact(other)]); expect(disjoint.status).toBe(200); await disjoint.text();
    const conflict = await write(graph, id, [fact(other)]); expect(conflict.status).toBe(409); await conflict.text();
    for (const name of [transactionCoordinatorName(graph, id), treeCoordinatorName(graph, root)])
      await evictDurableObject(env.GRAPH_COORDINATORS.getByName(name));
    await evictDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)));
    expect((await write(graph, id, [fact(first)])).status).toBe(200);
    expect((await write(graph, id, [fact(first)])).status).toBe(200);
    expect(await leafCount(graph, root)).toBe(1);
    expect((await query(graph)).status).toBe(200);
  });

  it.each([false, true])("does not expire local authority while publication is unresolved (abort=%s)", async abort => {
    const graph = `test-${crypto.randomUUID()}`, {first, root} = await fixtures(graph), id = "atomic:pinned";
    const facts = [fact(first, abort, abort ? "missing" : "alive")];
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), async instance => {
      const atomic = Reflect.get(instance, "atomic");
      Reflect.set(instance, "atomic", async (...args: unknown[]) => {const answer = await atomic.apply(instance, args); await answer.text(); return new Response("lost", {status: 503});});
      try {const response = await write(graph, id, facts); expect(response.status).toBe(503); await response.text();}
      finally {Reflect.set(instance, "atomic", atomic);}
    });
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), (_instance, state) => state.storage.sql.exec("UPDATE shard_transactions SET created_at_ms = 0"));
    await runDurableObjectAlarm(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)));
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), (_instance, state) =>
      expect(state.storage.sql.exec("SELECT status, atomic_published FROM shard_transactions").one()).toMatchObject({status: abort ? "cancelled" : "committed", atomic_published: 0}));
    expect((await write(graph, id, facts)).status).toBe(abort ? 422 : 200);
    expect(await leafCount(graph, root)).toBe(abort ? 0 : 1);
    await runInDurableObject(env.GRAPH_COORDINATORS.getByName(transactionCoordinatorName(graph, id)), (_instance, state) =>
      expect(state.storage.sql.exec("SELECT phase FROM candidate_transactions").one()).toMatchObject({phase: abort ? "aborted" : "complete"}));
  });

  it("preserves acknowledged publication despite finalization failure and cleans metadata by proof", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, root} = await fixtures(graph), id = "atomic:cleanup";
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), async instance => {
      const finalize = Reflect.get(instance, "finalizeAtomic");
      Reflect.set(instance, "finalizeAtomic", () => new Response("maintenance unavailable", {status: 503}));
      try {expect((await write(graph, id, [fact(first)])).status).toBe(200);}
      finally {Reflect.set(instance, "finalizeAtomic", finalize);}
    });
    await runDurableObjectAlarm(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)));
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT atomic_published FROM shard_transactions").one()).toMatchObject({atomic_published: 1});
      state.storage.sql.exec("UPDATE shard_transactions SET created_at_ms = 0");
    });
    await runDurableObjectAlarm(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)));
    expect(await leafCount(graph, root)).toBe(1);
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), (_instance, state) =>
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM shard_transactions").one().count).toBe(0));
  });

  it("binds an authoritative abort without publishing or changing projections", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, root} = await fixtures(graph);
    expect((await write(graph, "atomic:seed", [fact(first)])).status).toBe(200);
    expect((await write(graph, "atomic:invalid", [fact(first, false, "changed"), fact(first, true, "missing")])).status).toBe(422);
    expect((await write(graph, "atomic:invalid", [fact(first)])).status).toBe(409);
    expect((await write(graph, "atomic:invalid", [fact(first, false, "changed"), fact(first, true, "missing")])).status).toBe(422);
    expect(await leafCount(graph, root)).toBe(1);
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), (_instance, state) =>
      expect(state.storage.sql.exec("SELECT status, atomic_rejection_status, atomic_fact_count, atomic_published FROM shard_transactions WHERE tx_id = 'atomic:invalid'").one())
        .toMatchObject({status: "cancelled", atomic_rejection_status: 422, atomic_fact_count: 0, atomic_published: 1}));
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(1);
  });

  it("returns a discarded global receipt after migration without reappending to children", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, second, root} = await fixtures(graph), id = "atomic:migration";
    await (await write(graph, id, [fact(first), fact(second)])).text();
    expect((await split(graph, root)).status).toBe(200);
    await evictDurableObject(env.GRAPH_COORDINATORS.getByName(transactionCoordinatorName(graph, id)));
    expect((await write(graph, id, [fact(first), fact(second)])).status).toBe(200);
    expect(await leafCount(graph, `${root}0`) + await leafCount(graph, `${root}1`)).toBe(2);
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(2);
  });

  it("uses ordinary distributed staging when one owner spans multiple physical leaves", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, second, root} = await fixtures(graph);
    expect((await write(graph, "atomic:split-seed", [fact(first), fact(second)])).status).toBe(200);
    expect((await split(graph, root, 1)).status).toBe(503);
    expect((await split(graph, root)).status).toBe(200);
    expect((await write(graph, "atomic:multi-leaf", [fact(first, false, "next"), fact(second, false, "next")])).status).toBe(200);
    for (const prefix of [`${root}0`, `${root}1`]) await runInDurableObject(env.GRAPH_SHARDS.getByName(address(graph, prefix)), (_instance, state) =>
      expect(state.storage.sql.exec("SELECT status, decision_kind FROM shard_transactions WHERE tx_id = 'atomic:multi-leaf'").one()).toMatchObject({status: "committed", decision_kind: "distributed"}));
  });

  it("replays a retained retraction before mutable validation and capacity checks", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, root} = await fixtures(graph), id = "atomic:capacity-replay";
    expect((await write(graph, "atomic:capacity-seed", [fact(first)])).status).toBe(200);
    let saved: unknown;
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), async instance => {
      const atomic = Reflect.get(instance, "atomic");
      Reflect.set(instance, "atomic", async (request: Request) => {saved = await request.clone().json(); return atomic.call(instance, request);});
      try {expect((await write(graph, id, [fact(first, true)])).status).toBe(200);}
      finally {Reflect.set(instance, "atomic", atomic);}
    });
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), async (instance, state) => {
      // Synthetic accounted pressure, not a physical capacity/performance test.
      state.storage.sql.exec("UPDATE shard_accounting SET synthetic_size_bytes = ?", MAX_ACCOUNTED_BYTES_PER_DO);
      try {
        const replay = await instance.fetch(new Request("https://leaf.internal/_atomic", {method: "POST", body: JSON.stringify(saved)}));
        expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({status: "committed"});
      } finally {state.storage.sql.exec("UPDATE shard_accounting SET synthetic_size_bytes = 0");}
    });
    expect(await leafCount(graph, root)).toBe(2);
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(0);
  });

  it("keeps stale-generation refusal delegated instead of inventing abort", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, root} = await fixtures(graph), id = "atomic:stale";
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), async (instance, state) => {
      const atomic = Reflect.get(instance, "atomic");
      Reflect.set(instance, "atomic", async (...args: unknown[]) => {
        state.storage.sql.exec("UPDATE shard_identity SET generation = generation + 1");
        try {return await atomic.apply(instance, args);}
        finally {state.storage.sql.exec("UPDATE shard_identity SET generation = generation - 1");}
      });
      try {const response = await write(graph, id, [fact(first)]); expect(response.status).toBe(503); await response.text();}
      finally {Reflect.set(instance, "atomic", atomic);}
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM shard_transactions").one().count).toBe(0);
    });
    await runInDurableObject(env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph, root)), (_instance, state) =>
      expect(state.storage.sql.exec("SELECT phase, atomic_authority FROM graph_transactions WHERE tx_id = ?", id).one()).toMatchObject({phase: "delegated", atomic_authority: 1}));
    expect((await write(graph, id, [fact(first)])).status).toBe(200);
    expect(await leafCount(graph, root)).toBe(1);
  });

  it("recovers lost owner publication confirmation before the graph receipt was recorded", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, root} = await fixtures(graph), id = "atomic:lost-owner";
    await runInDurableObject(env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph, root)), async instance => {
      const finish = Reflect.get(instance, "finishDelegation");
      Reflect.set(instance, "finishDelegation", async (...args: unknown[]) => {await finish.apply(instance, args); throw new Error("lost owner publication answer");});
      try {const response = await write(graph, id, [fact(first)]); expect(response.status).toBe(503); await response.text();}
      finally {Reflect.set(instance, "finishDelegation", finish);}
    });
    const visible = await query(graph); expect(visible.status).toBe(200); await visible.text();
    await evictDurableObject(env.GRAPH_COORDINATORS.getByName(transactionCoordinatorName(graph, id)));
    expect((await write(graph, id, [fact(first)])).status).toBe(200);
    expect(await leafCount(graph, root)).toBe(1);
  });

  it("bounds publication-proof maintenance and expiry to 100 records without touching facts", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, root} = await fixtures(graph);
    expect((await write(graph, "atomic:bounds-seed", [fact(first)])).status).toBe(200);
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), async (instance, state) => {
      // Synthetic terminal metadata only, not acknowledged write/load evidence.
      for (let index = 0; index < 102; index++) state.storage.sql.exec(`INSERT INTO shard_transactions
        (tx_id, payload_hash, status, created_at_ms, decision_kind, atomic_commit_seq, atomic_statement_ms,
         atomic_fact_count, atomic_rejection_status, atomic_error, atomic_published)
        VALUES (?, ?, 'cancelled', 0, 'atomic', 1, 1, 0, 422, 'fixture', 0)`, `atomic:bound-${index}`, "0".repeat(64));
      await Reflect.get(instance, "scheduleAtomicMaintenance").call(instance);
    });
    await runDurableObjectAlarm(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)));
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), (_instance, state) => {
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM shard_transactions WHERE atomic_published = 0").one().count).toBe(2);
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM shard_transactions WHERE created_at_ms = 0").one().count).toBe(102);
    });
    await runDurableObjectAlarm(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)));
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), (_instance, state) =>
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM shard_transactions WHERE created_at_ms = 0").one().count).toBe(4));
    expect(await leafCount(graph, root)).toBe(1);
  });

  it("rejects B1 persisted schema markers without mutation", async () => {
    const graph = `test-${crypto.randomUUID()}`, {root} = await fixtures(graph);
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), (_instance, state) => {
      state.storage.sql.exec("UPDATE poneglyph_schema SET kind = 'candidate-shard', version = 2");
      expect(() => ensureShardSchema(state.storage)).toThrow();
      expect(state.storage.sql.exec("SELECT kind, version FROM poneglyph_schema").one()).toMatchObject({kind: "candidate-shard", version: 2});
      state.storage.sql.exec("UPDATE poneglyph_schema SET kind = 'e-shard', version = 5");
    });
  });
});
