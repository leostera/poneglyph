import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as selected from "../src/database-implementation.js";
import * as candidate from "../src/storage-c/implementation.js";
import { DistributedTransaction } from "../src/storage-c/transaction.js";
import { transactionCoordinatorName, treeCoordinatorName, treeForKey } from "../src/storage-c/forest.js";
import { bitAt, virtualKeyForEntity } from "../src/storage-c/keys.js";
import { ensureCoordinatorSchema } from "../src/storage-c/sql.js";
import { TRANSACTION_IDEMPOTENCY_RETENTION_MS } from "../src/storage-c/constants.js";

const fact = (entity: string, value = "alive", retraction = false) => ({source: "agent:c", entity,
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
async function disjointEntities(graph: string) {
  const found = new Map<string, string>();
  for (let i = 0; found.size < 4 && i < 1000; i++) {
    const entity = `wiki:person:c-${i}`;
    found.set(treeForKey(await virtualKeyForEntity(graph, entity)), entity);
  }
  expect(found.size).toBe(4);
  return [...found.values()];
}
async function collidingId(graph: string, first: string, stem: string) {
  const name = await transactionCoordinatorName(graph, first);
  for (let i = 0; i < 1000; i++) {
    const id = `${stem}:${i}`;
    if (await transactionCoordinatorName(graph, id) === name) return id;
  }
  throw new Error("could not find test ledger collision");
}

describe.runIf(Object.is(selected.GraphCoordinatorDO, candidate.GraphCoordinatorDO))("C pooled transaction ledger", () => {
  it("rejects incumbent persistence without mutating it", async () => {
    const stub = env.GRAPH_COORDINATORS.getByName(`c-schema:${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE poneglyph_schema SET kind = 'candidate-coordinator', version = 2 WHERE singleton = 1");
      expect(() => ensureCoordinatorSchema(state.storage)).toThrow(/schema/);
      expect(state.storage.sql.exec<{kind: string; version: number}>("SELECT kind, version FROM poneglyph_schema").one())
        .toMatchObject({kind: "candidate-coordinator", version: 2});
    });
  });

  it("a held transaction does not reserve its ledger; same-pool disjoint transactions and retries keep independent records", async () => {
    const graph = `test-${crypto.randomUUID()}`, [a, b, c, d] = await disjointEntities(graph);
    const first = "c:held", second = await collidingId(graph, first, "c:disjoint"), overlap = await collidingId(graph, first, "c:overlap");
    const stub = env.GRAPH_COORDINATORS.getByName(await transactionCoordinatorName(graph, first));
    await runInDurableObject(stub, async (instance, state) => {
      const prototype = DistributedTransaction.prototype, original = Reflect.get(prototype, "participant");
      let release!: () => void, reached!: () => void;
      const gate = new Promise<void>(resolve => {release = resolve;}), arrival = new Promise<void>(resolve => {reached = resolve;});
      Reflect.set(prototype, "participant", async function(this: DistributedTransaction, ...args: unknown[]) {
        if ((args[0] as {tx_id: string}).tx_id === first && args[2] === "_commit") { reached(); await gate; }
        return original.apply(this, args);
      });
      const pending = instance.fetch(new Request("https://ledger.internal/_transact", {
        method: "POST", body: JSON.stringify({graphId: graph, batch: {txId: first, facts: [fact(a!), fact(b!)]}}),
      }));
      try {
        await arrival;
        expect((await write(graph, second, [fact(c!), fact(d!)])).status).toBe(200);
        expect((await write(graph, second, [fact(c!), fact(d!)])).status).toBe(200);
        expect((await write(graph, overlap, [fact(a!)])).status).toBe(423);
        expect((await write(graph, first, [fact(c!)])).status).toBe(409);
        expect((await query(graph)).status).toBe(423);
        const rows = state.storage.sql.exec<{tx_id: string; phase: string}>("SELECT tx_id, phase FROM candidate_transactions ORDER BY tx_id").toArray();
        expect(rows).toHaveLength(2);
        expect(rows.find(row => row.tx_id === first)?.phase).toBe("committing");
        expect(rows.find(row => row.tx_id === second)?.phase).toBe("complete");
      } finally { release(); Reflect.set(prototype, "participant", original); }
      expect((await pending).status).toBe(200);
    });
    expect((await write(graph, overlap, [fact(a!)])).status).toBe(200);
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(4);
  });

  it("recovers a durable partial commit after actual DO eviction, with no caller replay", async () => {
    const graph = `test-${crypto.randomUUID()}`, [a, b] = await disjointEntities(graph), id = "c:recover";
    const stub = env.GRAPH_COORDINATORS.getByName(await transactionCoordinatorName(graph, id));
    await runInDurableObject(stub, async instance => {
      const prototype = DistributedTransaction.prototype, original = Reflect.get(prototype, "participant");
      let failed = false;
      Reflect.set(prototype, "participant", async function(this: DistributedTransaction, ...args: unknown[]) {
        if (args[2] === "_commit" && !failed) {failed = true; return new Response("injected apply failure", {status: 503});}
        return original.apply(this, args);
      });
      try {
        expect((await instance.fetch(new Request("https://ledger.internal/_transact", {
          method: "POST", body: JSON.stringify({graphId: graph, batch: {txId: id, facts: [fact(a!), fact(b!)]}}),
        }))).status).toBe(503);
      } finally {Reflect.set(prototype, "participant", original);}
    });
    expect((await query(graph)).status).toBe(423);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec<{phase: string}>("SELECT phase FROM candidate_transactions WHERE tx_id = ?", id).one().phase).toBe("committing");
      state.storage.sql.exec("UPDATE candidate_transactions SET next_recovery_at_ms = 0 WHERE tx_id = ?", id);
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{phase: string}>("SELECT phase FROM candidate_transactions WHERE tx_id = ?", id).one().phase).toBe("complete");
    });
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(2);
    expect((await write(graph, id, [fact(a!), fact(b!)])).status).toBe(200);
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(2);
  });

  it.each(["_prepare", "_tree-finish"])("recovers %s interruption without torn graph visibility", async action => {
    const graph = `test-${crypto.randomUUID()}`, [a, b] = await disjointEntities(graph), id = `c:recover:${action}`;
    const stub = env.GRAPH_COORDINATORS.getByName(await transactionCoordinatorName(graph, id));
    await runInDurableObject(stub, async instance => {
      const prototype = DistributedTransaction.prototype, method = action === "_prepare" ? "participant" : "tree";
      const original = Reflect.get(prototype, method);
      let calls = 0;
      Reflect.set(prototype, method, async function(this: DistributedTransaction, ...args: unknown[]) {
        // Fail after another participant/owner completed its corresponding step.
        if (args[2] === action && calls++ === 1) return new Response("injected phase interruption", {status: 503});
        return original.apply(this, args);
      });
      try {
        expect((await instance.fetch(new Request("https://ledger.internal/_transact", {
          method: "POST", body: JSON.stringify({graphId: graph, batch: {txId: id, facts: [fact(a!), fact(b!)]}}),
        }))).status).toBe(503);
      } finally {Reflect.set(prototype, method, original);}
    });
    expect((await query(graph)).status).toBe(423);
    await evictDurableObject(stub);
    expect((await write(graph, id, [fact(a!), fact(b!)])).status).toBe(200);
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(2);
  });

  it("retains a lost-response receipt and payload binding after eviction", async () => {
    const graph = `test-${crypto.randomUUID()}`, [a, b, c] = await disjointEntities(graph), id = "c:lost-response";
    const committed = await write(graph, id, [fact(a!), fact(b!)]);
    expect(committed.status).toBe(200);
    // Discard the response exactly as a caller with no commit answer would do.
    await committed.body?.cancel();
    const stub = env.GRAPH_COORDINATORS.getByName(await transactionCoordinatorName(graph, id));
    await evictDurableObject(stub);
    expect((await write(graph, id, [fact(a!), fact(b!)])).status).toBe(200);
    expect((await write(graph, id, [fact(c!)])).status).toBe(409);
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(2);
  });

  it("does not turn a published commit into failed acknowledgement on terminal maintenance error", async () => {
    const graph = `test-${crypto.randomUUID()}`, [a] = await disjointEntities(graph), id = "c:maintenance";
    const stub = env.GRAPH_COORDINATORS.getByName(await transactionCoordinatorName(graph, id));
    await runInDurableObject(stub, async (instance, state) => {
      const ledger = Reflect.get(instance, "ledger"), original = Reflect.get(ledger, "schedule");
      let calls = 0;
      Reflect.set(ledger, "schedule", async () => {
        if (++calls === 2) throw new Error("injected terminal scheduling failure");
        return original.call(ledger);
      });
      try {
        expect((await instance.fetch(new Request("https://ledger.internal/_transact", {
          method: "POST", body: JSON.stringify({graphId: graph, batch: {txId: id, facts: [fact(a!)]}}),
        }))).status).toBe(200);
        expect(state.storage.sql.exec<{phase: string}>("SELECT phase FROM candidate_transactions WHERE tx_id = ?", id).one().phase).toBe("complete");
        expect(await state.storage.getAlarm()).not.toBeNull();
      } finally {Reflect.set(ledger, "schedule", original);}
    });
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(1);
  });

  it("abort and delete transitions affect only their ID, never their neighbor in the same ledger", async () => {
    const graph = `test-${crypto.randomUUID()}`, [a, b, c] = await disjointEntities(graph), seed = "c:seed";
    const invalid = await collidingId(graph, seed, "c:invalid");
    expect((await write(graph, seed, [fact(a!), fact(b!)])).status).toBe(200);
    expect((await write(graph, invalid, [fact(a!, "changed"), fact(b!, "missing", true)])).status).toBe(422);
    expect((await write(graph, seed, [fact(c!)])).status).toBe(409);
    expect((await write(graph, seed, [fact(a!), fact(b!)])).status).toBe(200);
    const stub = env.GRAPH_COORDINATORS.getByName(await transactionCoordinatorName(graph, seed));
    await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql.exec<{tx_id: string; phase: string}>("SELECT tx_id, phase FROM candidate_transactions").toArray();
      expect(rows).toHaveLength(2);
      expect(rows.find(row => row.tx_id === seed)?.phase).toBe("complete");
      expect(rows.find(row => row.tx_id === invalid)?.phase).toBe("aborted");
    });
    const result = await (await query(graph)).json() as {rows: {Status: {value: string}}[]};
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every(row => row.Status.value === "alive")).toBe(true);
  });

  it("preserves interrupted subtree recovery and progress in unrelated owners", async () => {
    const graph = `test-${crypto.randomUUID()}`, first = "wiki:person:c-split-first";
    const firstKey = await virtualKeyForEntity(graph, first), root = treeForKey(firstKey);
    let second = "", other = "";
    for (let i = 0; !second || !other; i++) {
      const entity = `wiki:person:c-split-${i}`, key = await virtualKeyForEntity(graph, entity);
      if (treeForKey(key) !== root) other = entity;
      else if (bitAt(key, 4) !== bitAt(firstKey, 4)) second = entity;
    }
    expect((await write(graph, "c:split-seed", [fact(first), fact(second)])).status).toBe(200);
    const facade = env.GRAPH_COORDINATORS.getByName(candidate.coordinatorObjectName(graph));
    expect((await facade.fetch("https://graph.internal/_split", {method: "POST", body: JSON.stringify({graphId: graph, prefix: root, force: true, stopAfterPages: 1})})).status).toBe(503);
    expect((await write(graph, "c:split-disjoint", [fact(other)])).status).toBe(200);
    expect((await query(graph)).status).toBe(423);
    expect((await facade.fetch("https://graph.internal/_split", {method: "POST", body: JSON.stringify({graphId: graph, prefix: root, force: true})})).status).toBe(200);
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(3);
  });

  it("keeps leased subtree cuts fenced and releases expired leases", async () => {
    const graph = `test-${crypto.randomUUID()}`, [a] = await disjointEntities(graph);
    expect((await write(graph, "c:lease-seed", [fact(a!)])).status).toBe(200);
    const prefix = treeForKey(await virtualKeyForEntity(graph, a!)), tree = env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph, prefix));
    const lease = await tree.fetch("https://tree.internal/_tree-read", {method: "POST", body: JSON.stringify({graphId: graph, prefix})});
    expect(lease.status).toBe(200);
    const body = await lease.json() as {readId: string};
    expect((await write(graph, "c:lease-blocked", [fact(a!, "later")])).status).toBe(423);
    await runInDurableObject(tree, (_instance, state) => {
      state.storage.sql.exec("UPDATE graph_read_leases SET expires_at_ms = 0 WHERE read_id = ?", body.readId);
    });
    expect((await write(graph, "c:lease-blocked", [fact(a!, "later")])).status).toBe(200);
  });

  it("bounds recovery dispatch to 100 records and six simultaneous drives", async () => {
    const graph = `test-${crypto.randomUUID()}`, [a] = await disjointEntities(graph), id = "c:bounded";
    expect((await write(graph, id, [fact(a!)])).status).toBe(200);
    const stub = env.GRAPH_COORDINATORS.getByName(await transactionCoordinatorName(graph, id));
    await runInDurableObject(stub, async (instance: candidate.GraphCoordinatorDO, state) => {
      // Metadata-only fixture; participant I/O is replaced below solely to
      // observe dispatch bounds, not to claim these are completed writes.
      for (let i = 0; i < 101; i++) {
        const txId = `c:pending:${i}`, json = JSON.stringify({txId, facts: [fact(a!)]});
        state.storage.sql.exec(`INSERT INTO candidate_transactions
          (tx_id, graph_id, payload_hash, batch_json, trees_json, phase, commit_seq, statement_time_ms, created_at_ms, next_recovery_at_ms)
          VALUES (?, ?, 'fixture', ?, '[]', 'preparing', 0, 0, ?, 0)`, txId, graph, json, Date.now());
      }
      const ledger = Reflect.get(instance, "ledger"), original = Reflect.get(ledger, "execute");
      let active = 0, peak = 0, drives = 0;
      Reflect.set(ledger, "execute", async () => {
        drives++; active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 1));
        active--;
        return new Response("fixture stays pending", {status: 503});
      });
      try {
        await instance.alarm();
        expect(drives).toBe(100);
        expect(peak).toBe(6);
        expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM candidate_transactions WHERE next_recovery_at_ms = 0").one().count).toBe(1);
        expect(await state.storage.getAlarm()).not.toBeNull();
      } finally {
        Reflect.set(ledger, "execute", original);
        state.storage.sql.exec("DELETE FROM candidate_transactions WHERE payload_hash = 'fixture'");
      }
    });
  });

  it("sweeps only expired terminal identities and never facts or unfinished decisions", async () => {
    const graph = `test-${crypto.randomUUID()}`, [a, b, c] = await disjointEntities(graph), expired = "c:expire";
    const fresh = await collidingId(graph, expired, "c:fresh"), pending = await collidingId(graph, expired, "c:pending");
    for (const [id, entity] of [[expired, a!], [fresh, b!], [pending, c!]]) expect((await write(graph, id!, [fact(entity!)])).status).toBe(200);
    const stub = env.GRAPH_COORDINATORS.getByName(await transactionCoordinatorName(graph, expired));
    await runInDurableObject(stub, async (instance: candidate.GraphCoordinatorDO, state) => {
      const old = Date.now() - TRANSACTION_IDEMPOTENCY_RETENTION_MS - 1_000;
      state.storage.sql.exec("UPDATE candidate_transactions SET created_at_ms = ? WHERE tx_id = ?", old, expired);
      for (let i = 0; i < 100; i++) {
        // Expired metadata-only entries exercise the sweep page bound.
        state.storage.sql.exec(`INSERT INTO candidate_transactions
          (tx_id, graph_id, payload_hash, batch_json, trees_json, phase, commit_seq, statement_time_ms, created_at_ms, next_recovery_at_ms)
          VALUES (?, ?, 'fixture', '{}', '[]', 'complete', 1, 0, ?, 0)`, `c:expired:${i}`, graph, old);
      }
      // Simulate an old unfinished record without driving a fictional decision:
      // its future deadline keeps this test strictly about terminal sweeping.
      state.storage.sql.exec("UPDATE candidate_transactions SET phase = 'committing', created_at_ms = ?, next_recovery_at_ms = ? WHERE tx_id = ?", old, Date.now() + 60_000, pending);
      await instance.alarm();
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM candidate_transactions").one().count).toBe(3);
      await instance.alarm();
      const rows = state.storage.sql.exec<{tx_id: string}>("SELECT tx_id FROM candidate_transactions").toArray();
      expect(rows.map(row => row.tx_id).sort()).toEqual([fresh, pending].sort());
      state.storage.sql.exec("UPDATE candidate_transactions SET phase = 'complete' WHERE tx_id = ?", pending);
    });
    expect((await (await query(graph)).json() as {rows: unknown[]}).rows).toHaveLength(3);
  });
});
