import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { treeCoordinatorName, treeForKey } from "../src/storage/forest.js";
import { virtualKeyForEntity } from "../src/storage/keys.js";

// RFD0012: a lock request that meets a split's fence waits for the split to
// end instead of bouncing back, so fenced writers don't retry in a storm.
describe("owner fence hold", () => {
  it("answers a lock held during a split once the split clears", async () => {
    const graph = `fence-${crypto.randomUUID()}`, owner = "0101";
    let entity = "";
    for (let index = 0; !entity; index++) {
      const candidate = `fence:entity:${index}`;
      if (treeForKey(await virtualKeyForEntity(graph, candidate)) === owner) entity = candidate;
    }
    const tree = env.GRAPH_TREES.getByName(treeCoordinatorName(graph as never, owner as never));
    const call = (action: string, body: object) => tree.fetch(`https://owner.internal/${action}`, {
      method: "POST", body: JSON.stringify({graphId: graph, prefix: owner, ...body}),
    });
    const directory = await (await call("_tree-directory", {})).json() as {directoryEpoch: number};
    await runInDurableObject(tree, (_instance, state) => {
      state.storage.sql.exec("UPDATE graph_state SET topology_op_id = 'fence-test' WHERE singleton = 1");
    });

    let settled = false;
    const lock = call("_tree-lock", {txId: "poneglyph:tx:fence", payloadHash: "a".repeat(64), identityTimeMs: Date.now(),
      entities: [entity], directoryEpoch: directory.directoryEpoch, gate: true}).then(response => {settled = true; return response;});
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(settled).toBe(false);

    await runInDurableObject(tree, instance => (Reflect.get(instance, "clearSplit") as (id: string) => void).call(instance, "fence-test"));
    const response = await lock;
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({reservationTicket: 1, publicationSeq: 1});
  });
});
