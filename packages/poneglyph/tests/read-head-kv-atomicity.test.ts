import {evictDurableObject, runInDurableObject} from "cloudflare:test";
import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import {parseGraphId} from "../src/domain/graph-id.js";
import {TREE_PREFIXES} from "../src/storage/forest.js";
import {coordinatorObjectName} from "../src/storage/keys.js";
import {parseReadHeadParent, createReadHeadParent, beginReadHeadPublication} from "../src/storage/read-head-parent.js";
import {parseReadHeadView} from "../src/storage/read-head-state.js";

// Placement feasibility gate only: no production metadata role or journal hook.
// Versioned KV is journal/projection metadata, never canonical fact/entity truth.
const KEY = "test/read-head-parent/v1";
function graph() {
  const parsed = parseGraphId(`test-head-kv-${crypto.randomUUID()}`);
  if (!parsed.ok) throw new Error("invalid fixture graph");
  return parsed.value;
}
function view(frontier: number) {
  return parseReadHeadView({frontier, vector: TREE_PREFIXES.map((prefix, index) => ({
    prefix, snapshotSeq: index === 0 ? frontier : 0, directoryEpoch: 0,
  }))});
}
function publishFixture(storage: DurableObjectStorage): void {
  storage.sql.exec("UPDATE graph_safe_vector SET visible_seq = 1 WHERE prefix = ?", TREE_PREFIXES[0]!);
  storage.sql.exec("UPDATE graph_safe_frontier SET frontier = 1 WHERE singleton = 1");
}
function sqlFrontier(storage: DurableObjectStorage): number {
  return storage.sql.exec<{frontier: number}>("SELECT frontier FROM graph_safe_frontier WHERE singleton = 1").one().frontier;
}

describe("read-head journal mixed synchronous KV/SQLite atomicity", () => {
  it("rolls back BOTH the SQL vector and a new KV journal record", async () => {
    const graphId = graph(), stub = env.GRAPH_FACADES.getByName(coordinatorObjectName(graphId));
    const parent = beginReadHeadPublication(createReadHeadParent(graphId, view(0)), view(1));
    await expect(runInDurableObject(stub, (_instance, ctx) => {
      ctx.storage.transactionSync(() => {
        publishFixture(ctx.storage);
        ctx.storage.kv.put(KEY, parent);
        throw new Error("test crash before atomic commit");
      });
    })).rejects.toThrow("before atomic commit");
    await evictDurableObject(stub);
    await runInDurableObject(stub, (_instance, ctx) => {
      expect(sqlFrontier(ctx.storage)).toBe(0);
      expect(ctx.storage.sql.exec<{visible_seq: number}>("SELECT visible_seq FROM graph_safe_vector WHERE prefix = ?", TREE_PREFIXES[0]!).one().visible_seq).toBe(0);
      expect(ctx.storage.kv.get(KEY)).toBeUndefined();
    });
  });

  it("rolls back replacement of an existing KV checkpoint together with SQL writes", async () => {
    const graphId = graph(), stub = env.GRAPH_FACADES.getByName(coordinatorObjectName(graphId));
    const before = createReadHeadParent(graphId, view(0)), after = beginReadHeadPublication(before, view(1));
    await runInDurableObject(stub, (_instance, ctx) => ctx.storage.kv.put(KEY, before));
    await expect(runInDurableObject(stub, (_instance, ctx) => {
      ctx.storage.transactionSync(() => {
        publishFixture(ctx.storage);
        ctx.storage.kv.put(KEY, after);
        throw new Error("test crash during checkpoint replacement");
      });
    })).rejects.toThrow("checkpoint replacement");
    await evictDurableObject(stub);
    await runInDurableObject(stub, (_instance, ctx) => {
      expect(sqlFrontier(ctx.storage)).toBe(0);
      expect(parseReadHeadParent(ctx.storage.kv.get(KEY))).toEqual(before);
    });
  });

  it("preserves BOTH sides after commit, lost response and actor eviction", async () => {
    const graphId = graph(), stub = env.GRAPH_FACADES.getByName(coordinatorObjectName(graphId));
    const parent = beginReadHeadPublication(createReadHeadParent(graphId, view(0)), view(1));
    await expect(runInDurableObject(stub, (_instance, ctx) => {
      ctx.storage.transactionSync(() => {
        publishFixture(ctx.storage);
        ctx.storage.kv.put(KEY, parent);
      });
      throw new Error("test lost committed response");
    })).rejects.toThrow("lost committed response");
    await evictDurableObject(stub);
    await runInDurableObject(stub, (_instance, ctx) => {
      expect(sqlFrontier(ctx.storage)).toBe(1);
      expect(ctx.storage.sql.exec<{visible_seq: number}>("SELECT visible_seq FROM graph_safe_vector WHERE prefix = ?", TREE_PREFIXES[0]!).one().visible_seq).toBe(1);
      expect(parseReadHeadParent(ctx.storage.kv.get(KEY))).toEqual(parent);
      expect(ctx.storage.sql.exec<{version: number}>("SELECT version FROM poneglyph_schema WHERE singleton = 1").one().version).toBe(2);
    });
  });
});
