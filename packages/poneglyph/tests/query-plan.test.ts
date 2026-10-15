import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { FactInput, QueryResult } from "../src/client.js";
import { treeForKey, treeCoordinatorName, TREE_PREFIXES } from "../src/storage/forest.js";
import { virtualKeyForEntity, coordinatorObjectName, shardObjectName } from "../src/storage/keys.js";
import { valueIndexKeysForDatalogValue } from "../src/storage/value-index.js";

async function write(graph: string, txId: string, facts: readonly FactInput[]) {
  const response = await exports.default.fetch(new Request(`https://database.test/v1/graphs/${graph}/transactions`, {method: "POST", body: JSON.stringify({txId, facts: facts.map(fact => ({...fact, retraction: fact.retraction ?? false}))})}));
  expect(response.status, await response.text()).toBe(200);
}
async function query(graph: string, source: string) {
  return exports.default.fetch(new Request(`https://database.test/v1/graphs/${graph}/query`, {method: "POST", body: JSON.stringify({query: source})}));
}
const source = 'test:category(Page, "captain"), test:title(Page, Title)';

// Explicit fixture bags here complement the independent conformance model.
describe("owner-local query plan", () => {
  it("preserves bag products across SQL pages, retractions and expandable routing", async () => {
    const graph = `test-${crypto.randomUUID()}`, entity = "test:captain";
    const categories: FactInput[] = Array.from({length: 20}, (_, index) => ({source: `agent:category-${index}`, entity, field: "test:category", value: {type: "text", value: "captain"}}));
    const titles: FactInput[] = Array.from({length: 20}, (_, index) => ({source: `agent:title-${index}`, entity, field: "test:title", value: {type: "text", value: "Name"}}));
    await write(graph, "query:seed", [...categories, ...titles]);
    async function check(count: number, leaves: number) {
      const response = await query(graph, source); expect(response.status).toBe(200);
      const result = await response.json() as QueryResult & {snapshotVector: readonly {prefix: string}[]};
      expect(result.rows).toEqual(Array.from({length: count}, () => ({Page: {type: "string", value: entity}, Title: {type: "string", value: "Name"}})));
      expect(result.metrics).toMatchObject({scanCalls: 1, shardRequests: leaves, distinctShardsTouched: leaves, treeReadLeaseAcquisitions: 16, tuplesRead: count});
      expect(result.snapshotVector).toHaveLength(16);
      expect(result.metrics.timing).toBeDefined();
      for (const duration of Object.values(result.metrics.timing!)) expect(Number.isSafeInteger(duration) && duration >= 0).toBe(true);
      const timing = result.metrics.timing!;
      expect(timing.executionMs).toBeGreaterThanOrEqual(timing.snapshotMs + timing.evaluationMs + timing.releaseMs);
    }
    await check(400, 16);
    await write(graph, "query:replace", [categories[0]!]); await check(400, 16);
    await write(graph, "query:retract", [{...categories[1]!, retraction: true}, {...titles[1]!, retraction: true}]);
    await check(361, 16);
    const prefix = treeForKey(await virtualKeyForEntity(graph, entity));
    const split = await env.GRAPH_COORDINATORS.getByName(coordinatorObjectName(graph)).fetch("https://graph.internal/_split", {method: "POST", body: JSON.stringify({graphId: graph, prefix, force: true})});
    expect(split.status).toBe(200);
    await check(361, 17);
  });

  it("uses one tree lease and reports one shard for a single entity-bound relation", async () => {
    const graph = `test-${crypto.randomUUID()}`, entity = "test:bound-query";
    await write(graph, "query:entity-bound", [{source: "agent:title", entity, field: "test:title", value: {type: "text", value: "Captain"}}]);
    const root = treeForKey(await virtualKeyForEntity(graph, entity));
    const response = await query(graph, `test:title(${JSON.stringify(entity)}, Title), Title = "Captain"`);
    expect(response.status).toBe(200);
    const result = await response.json() as QueryResult & {snapshotVector: readonly {prefix: string}[]};
    expect(result.rows).toEqual([{Title: {type: "string", value: "Captain"}}]);
    expect(result.snapshotVector.map(owner => owner.prefix)).toEqual([root]);
    expect(result.metrics).toMatchObject({scanCalls: 1, shardRequests: 1, distinctShardsTouched: 1, treeReadLeaseAcquisitions: 1});
    for (const prefix of TREE_PREFIXES) await runInDurableObject(env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph, prefix)), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM graph_read_leases").one()["count"]).toBe(0);
    });
  });

  it("uses the existing FactValue index for bound values without collapsing exposed Datalog types", async () => {
    const graph = `test-${crypto.randomUUID()}`;
    const facts: FactInput[] = [
      {source: "agent:text-one", entity: "test:text-true", field: "test:value", value: {type: "text", value: "true"}},
      {source: "agent:text-two", entity: "test:text-true", field: "test:value", value: {type: "text", value: "true"}},
      {source: "agent:boolean", entity: "test:boolean-true", field: "test:value", value: {type: "boolean", value: true}},
      {source: "agent:text-number", entity: "test:text-seven", field: "test:value", value: {type: "text", value: "7"}},
      {source: "agent:number", entity: "test:number-seven", field: "test:value", value: {type: "number", value: "7"}},
    ];
    await write(graph, "query:value-index", facts);

    const textResponse = await query(graph, 'test:value(Entity, "true")');
    expect(textResponse.status).toBe(200);
    const textResult = await textResponse.json() as QueryResult;
    expect(textResult.rows.map(row => row["Entity"]?.value).sort()).toEqual([
      "test:boolean-true", "test:text-true", "test:text-true",
    ]);
    expect(textResult.metrics).toMatchObject({treeReadLeaseAcquisitions: 16, distinctShardsTouched: 16});

    const integerResponse = await query(graph, "test:value(Entity, 7)");
    expect(integerResponse.status).toBe(200);
    const integerResult = await integerResponse.json() as QueryResult;
    expect(integerResult.rows).toEqual([{Entity: {type: "string", value: "test:number-seven"}}]);

    const entity = "test:text-true";
    const root = treeForKey(await virtualKeyForEntity(graph, entity));
    const keys = valueIndexKeysForDatalogValue({type: "string", value: "true"});
    const indexPlan = await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), (_instance, state) => {
      const placeholders = keys.map(() => "?").join(", ");
      return state.storage.sql.exec<{detail: string}>(
        `EXPLAIN QUERY PLAN SELECT entity FROM active_values WHERE field = ? AND value_key IN (${placeholders})
         AND valid_from_seq <= ? AND (valid_to_seq IS NULL OR valid_to_seq > ?) AND datalog_type = ? AND datalog_value = ?`,
        "test:value", ...keys, 10, 10, "string", "true",
      ).toArray().map(row => row.detail).join(" ");
    });
    expect(indexPlan).toContain("active_values_by_field_value_snapshot");
  });

  it("keeps int64 and text distinct, applies constraints, and excludes missing titles", async () => {
    const graph = `test-${crypto.randomUUID()}`, entity = "test:typed-captain";
    await write(graph, "query:typed", [
      {source: "agent:one", entity, field: "test:category", value: {type: "number", value: "9223372036854775807"}},
      {source: "agent:two", entity, field: "test:category", value: {type: "text", value: "9223372036854775807"}},
      {source: "agent:one", entity, field: "test:title", value: {type: "list", value: [{type: "text", value: "Name"}, {type: "text", value: "Name"}, {type: "number", value: "-9223372036854775808"}]}},
      {source: "agent:one", entity: "test:no-title", field: "test:category", value: {type: "number", value: "9223372036854775807"}},
    ]);
    for (const literal of ['9223372036854775807', '"9223372036854775807"']) {
      const response = await query(graph, `test:category(Page, ${literal}), test:title(Page, Title)`);
      expect(response.status).toBe(200);
      const result = await response.json() as QueryResult;
      expect(result.rows).toEqual([
        {Page: {type: "string", value: entity}, Title: {type: "string", value: "Name"}},
        {Page: {type: "string", value: entity}, Title: {type: "string", value: "Name"}},
        {Page: {type: "string", value: entity}, Title: {type: "integer", value: "-9223372036854775808"}},
      ]);
    }
    const filtered = await query(graph, 'test:category(Page, 9223372036854775807), test:title(Page, Title), eq(Title, "Name")');
    expect((await filtered.json() as QueryResult).rows).toHaveLength(2);
  });

  it("fails closed rather than truncating an oversized joined bag", async () => {
    const graph = `test-${crypto.randomUUID()}`, entity = "test:oversized-captain";
    const facts: FactInput[] = ["test:category", "test:title"].flatMap(field => Array.from({length: 46}, (_, index) => ({
      source: `agent:source-${index}`, entity, field, value: {type: "text" as const, value: field === "test:category" ? "captain" : "Name"},
    })));
    await write(graph, "query:oversized", facts);
    const response = await query(graph, source); expect(response.status).toBe(413);
    expect((await response.json() as Record<string, unknown>)["rows"]).toBeUndefined();
  });

  it("releases successful siblings when one owner refuses a read cut", async () => {
    const graph = `test-${crypto.randomUUID()}`, busy = TREE_PREFIXES[0]!;
    await runInDurableObject(env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph, busy)), (_instance, state) => {
      state.storage.sql.exec("UPDATE graph_state SET topology_op_id = 'test-busy' WHERE singleton = 1");
    });
    const response = await query(graph, source); expect(response.status).toBe(423);
    expect((await response.json() as Record<string, unknown>)["rows"]).toBeUndefined();
    for (const prefix of TREE_PREFIXES) await runInDurableObject(env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph, prefix)), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM graph_read_leases").one()["count"]).toBe(0);
    });
  });
});
