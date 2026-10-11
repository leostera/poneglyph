import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as selected from "../src/database-implementation.js";
import * as candidate from "../src/storage-candidate/implementation.js";
import { treeForKey, transactionCoordinatorName, treeCoordinatorName } from "../src/storage-candidate/forest.js";
import { bitAt, virtualKeyForEntity, shardObjectName } from "../src/storage-candidate/keys.js";

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

describe.runIf(Object.is(selected.GraphCoordinatorDO, candidate.GraphCoordinatorDO))("independent subtree candidate", () => {
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
