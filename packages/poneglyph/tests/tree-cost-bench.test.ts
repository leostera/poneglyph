import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { treeCoordinatorName, treeForKey } from "../src/storage/forest.js";
import { virtualKeyForEntity } from "../src/storage/keys.js";

// Opt-in microbenchmark for RFD0008 experiments: drives one owner tree with
// the two calls a single-owner write makes (lock with gate, finish), from many
// concurrent callers, and reports owner-tree calls per second. Local workerd
// numbers only compare revisions of the tree; they are not production rates.
const RUN = (env as unknown as {PONEGLYPH_RUN_BENCH?: string}).PONEGLYPH_RUN_BENCH === "1";
const WRITES = 3_000, CALLERS = 32, OWNER = "0101";

describe.skipIf(!RUN)("owner tree cost microbenchmark", () => {
  it("measures lock + finish pairs per second on one owner tree", async () => {
    const graph = `tree-bench-${crypto.randomUUID()}`;
    const entities: string[] = [];
    for (let index = 0; entities.length < WRITES; index++) {
      const entity = `bench:tree:${index}`;
      if (treeForKey(await virtualKeyForEntity(graph, entity)) === OWNER) entities.push(entity);
    }
    const tree = env.GRAPH_TREES.getByName(treeCoordinatorName(graph as never, OWNER as never));
    const call = async (action: string, body: object) => {
      const response = await tree.fetch(`https://owner.internal/${action}`, {method: "POST", body: JSON.stringify({graphId: graph, prefix: OWNER, ...body})});
      const value = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(`${action} ${response.status} ${JSON.stringify(value)}`);
      return value;
    };
    const directory = await call("_tree-directory", {});
    const write = async (index: number) => {
      const identity = {txId: `poneglyph:tx:bench:${index}`, payloadHash: index.toString(16).padStart(64, "0"), identityTimeMs: Date.now()};
      const lock = await call("_tree-lock", {...identity, entities: [entities[index]], directoryEpoch: directory["directoryEpoch"], gate: true});
      await call("_tree-finish", {...identity, reservationTicket: lock["reservationTicket"], publicationSeq: lock["publicationSeq"], singleOwner: true});
    };
    let next = 0;
    const started = performance.now();
    await Promise.all(Array.from({length: CALLERS}, async () => {for (let index = next++; index < WRITES; index = next++) await write(index);}));
    const seconds = (performance.now() - started) / 1000;
    console.log(JSON.stringify({treeBench: {writes: WRITES, callers: CALLERS, seconds: Number(seconds.toFixed(2)), writesPerSecond: Math.round(WRITES / seconds)}}));
    expect(next).toBeGreaterThanOrEqual(WRITES);
  }, 300_000);
});
