import {runInDurableObject} from "cloudflare:test";
import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import {treeForKey} from "../src/storage/forest.js";
import {shardObjectName, virtualKeyForEntity} from "../src/storage/keys.js";

const tables = ["shard_identity", "shard_transactions", "fact_log", "active_facts", "active_values", "entity_versions", "migration_import_pages", "shard_accounting"];

async function fixture(graph: string) {
  const prefix = treeForKey(await virtualKeyForEntity(graph, "test:subject"));
  const shard = env.GRAPH_SHARDS.getByName(shardObjectName(graph, prefix));
  const snapshot = () => runInDurableObject(shard, (_instance, state) => Object.fromEntries(
    tables.map(table => [table, state.storage.sql.exec(`SELECT * FROM ${table}`).toArray()]),
  ));
  return {shard, snapshot, control: {graphId: graph, shardPrefix: prefix, shardGeneration: 0, directoryEpoch: 0,
    txId: "test:decision", payloadHash: "0".repeat(64), commitSeq: 1, statementTimeMs: 1, identityTimeMs: 1}};
}

describe("native shard request boundary", () => {
  it("rejects malformed decision commands with the existing messages before mutating shard state", async () => {
    const f = await fixture("decision-boundary"), before = await f.snapshot();
    for (const path of ["/_commit", "/_cancel", "/_decision-finalize"]) {
      for (const {body, error} of [
        {body: "{", error: "request body must be valid JSON"},
        {body: "[]", error: "expected a commit object"},
        {body: JSON.stringify({...f.control, statementTimeMs: -1, txId: ""}), error: "invalid decision timestamps"},
        {body: JSON.stringify({...f.control, payloadHash: "not-a-digest"}), error: "invalid commit request"},
        {body: JSON.stringify({...f.control, padding: "x".repeat(4096)}), error: "request body exceeds the 4096-byte limit"},
      ]) {
        const response = await f.shard.fetch(`https://shard.test${path}`, {method: "POST", body});
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({error});
      }
    }
    expect(await f.snapshot()).toEqual(before);
  });

  it("retains commit's positive-publication check after shape parsing", async () => {
    const f = await fixture("decision-zero-revision"), before = await f.snapshot();
    const response = await f.shard.fetch("https://shard.test/_commit", {method: "POST", body: JSON.stringify({...f.control, commitSeq: 0})});
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({error: "commit publication revision must be positive"});
    expect(await f.snapshot()).toEqual(before);
  });

  it("preserves 404 responses for unknown paths and non-POST commands", async () => {
    const f = await fixture("decision-route-boundary"), before = await f.snapshot();
    for (const {method, path} of [
      {method: "GET", path: "/_commit"}, {method: "PUT", path: "/_cancel"},
      {method: "GET", path: "/_route"}, {method: "POST", path: "/unknown"},
    ]) {
      const response = await f.shard.fetch(`https://shard.test${path}`, {method});
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({error: "not found"});
    }
    expect(await f.snapshot()).toEqual(before);
  });
});
