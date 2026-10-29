import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { treeForKey } from "../src/storage/forest.js";
import { bitAt, virtualKeyForEntity } from "../src/storage/keys.js";

// Durable Object calls made by one public write, in order. These numbers are
// the point of the write-path simplification: change them deliberately.
async function traced(graph: string, facts: unknown[], clientRequestToken?: string): Promise<{status: number; calls: string[]}> {
  globalThis.__poneglyphCallTrace = [];
  try {
    const response = await exports.default.fetch(new Request(`https://database.test/v1/graphs/${graph}/transactions`, {
      method: "POST", body: JSON.stringify({facts, ...(clientRequestToken ? {clientRequestToken} : {})}),
    }));
    const body = await response.text();
    if (!response.ok) throw new Error(`write failed: ${response.status} ${body}`);
    return {status: response.status, calls: globalThis.__poneglyphCallTrace.map(call => call.replace(/\/v1\/graphs\/[^/]+/, "/v1/graphs/:graph"))};
  } finally { globalThis.__poneglyphCallTrace = undefined; }
}
const fact = (entity: string) => ({source: "agent:calls", entity, field: "wiki:person:status", value: {type: "text", value: "alive"}, retraction: false});

async function entities(graph: string) {
  const first = "wiki:person:calls-first", key = await virtualKeyForEntity(graph, first), root = treeForKey(key);
  let sameRoot = "", otherRoot = "";
  for (let i = 0; !sameRoot || !otherRoot; i++) {
    const entity = `wiki:person:calls-${i}`, next = await virtualKeyForEntity(graph, entity);
    if (treeForKey(next) === root && bitAt(next, 4) !== bitAt(key, 4)) sameRoot = entity;
    else if (treeForKey(next) !== root) otherRoot = entity;
  }
  return {first, sameRoot, otherRoot};
}

describe("durable object calls per write", () => {
  it("counts a single-entity write", async () => {
    const graph = `calls-${crypto.randomUUID()}`, {first} = await entities(graph);
    await traced(graph, [fact("wiki:person:warmup")]);
    const result = await traced(graph, [fact(first)]);
    expect(result.status).toBe(200);
    expect(result.calls).toEqual([
      "ledger /_transact", "tree /_tree-directory", "shard /_route",
      "tree /_tree-lock", "shard /_atomic", "tree /_tree-finish", "facade /_publish-vector",
    ]);
  });

  it("counts a write across two owner trees", async () => {
    const graph = `calls-${crypto.randomUUID()}`, {first, otherRoot} = await entities(graph);
    const result = await traced(graph, [fact(first), fact(otherRoot)]);
    expect(result.status).toBe(200);
    expect(result.calls).toEqual([
      "ledger /_transact", "tree /_tree-directory", "tree /_tree-directory",
      "shard /_route", "shard /_route", "tree /_tree-lock", "tree /_tree-lock",
      "shard /_prepare", "shard /_prepare", "tree /_tree-gate", "tree /_tree-gate", "shard /_commit", "shard /_commit",
      "tree /_tree-finish", "tree /_tree-finish", "facade /_publish-vector", "tree /_tree-release-gate", "tree /_tree-release-gate",
    ]);
  });

  it("counts a token write", async () => {
    const graph = `calls-${crypto.randomUUID()}`, {first} = await entities(graph);
    const result = await traced(graph, [fact(first)], "calls:token-1");
    expect(result.status).toBe(200);
    expect(result.calls).toEqual([
      "ledger /_request", "tree /_tree-directory", "shard /_route",
      "tree /_tree-lock", "shard /_atomic", "tree /_tree-finish", "facade /_publish-vector",
    ]);
  });
});
