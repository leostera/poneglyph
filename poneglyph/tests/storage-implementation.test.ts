import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as selected from "../src/database-implementation.js";
import * as baseline from "../src/storage/implementation.js";
import * as candidate from "../src/storage-candidate/implementation.js";
import { ensureCoordinatorSchema, ensureShardSchema } from "../src/storage-candidate/sql.js";
import { shardObjectName } from "../src/storage/keys.js";

describe("storage implementation boundary", () => {
  it("keeps Version A selected and uses independent candidate classes", () => {
    expect(selected.GraphCoordinatorDO).toBe(baseline.GraphCoordinatorDO);
    expect(selected.GraphShardDO).toBe(baseline.GraphShardDO);
    expect(selected.coordinatorObjectName).toBe(baseline.coordinatorObjectName);
    expect(candidate.GraphCoordinatorDO).not.toBe(baseline.GraphCoordinatorDO);
    expect(candidate.GraphShardDO).not.toBe(baseline.GraphShardDO);
  });

  it("rejects Version A databases at the candidate schema boundary without changing them", async () => {
    const graph = `test-${crypto.randomUUID()}`;
    const response = await exports.default.fetch(new Request(`https://poneglyph.test/v1/graphs/${graph}/transactions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ txId: "implementation:seed", facts: [{
        source: "agent:implementation", entity: "wiki:person:implementation", field: "schema:name",
        value: { type: "text", value: "Independent implementation" }, retraction: false,
      }] }),
    }));
    expect(response.status).toBe(200);
    const coordinator = env.GRAPH_COORDINATORS.getByName(baseline.coordinatorObjectName(graph));
    await runInDurableObject(coordinator, (_instance, state) => {
      expect(() => ensureCoordinatorSchema(state.storage)).toThrow(/refusing to reinterpret/);
      expect(state.storage.sql.exec<{kind: string}>("SELECT kind FROM poneglyph_schema").one().kind).toBe("coordinator");
      expect(state.storage.sql.exec<{phase: string}>("SELECT phase FROM graph_transactions").one().phase).toBe("complete");
    });
    const shard = env.GRAPH_SHARDS.getByName(shardObjectName(graph));
    await runInDurableObject(shard, (_instance, state) => {
      expect(() => ensureShardSchema(state.storage)).toThrow(/refusing to reinterpret/);
      expect(state.storage.sql.exec<{kind: string}>("SELECT kind FROM poneglyph_schema").one().kind).toBe("shard");
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM fact_log").one().count).toBe(1);
    });
  });
});
