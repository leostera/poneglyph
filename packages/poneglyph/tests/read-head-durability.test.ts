import {evictDurableObject, runInDurableObject} from "cloudflare:test";
import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import {parseGraphId} from "../src/domain/graph-id.js";
import {TREE_PREFIXES} from "../src/storage/forest.js";
import {coordinatorObjectName} from "../src/storage/keys.js";
import {
  acknowledgeReadHeadDelivery, beginReadHeadJoin, beginReadHeadPublication, beginReadHeadRetirement,
  pendingReadHeadDeliveries, type ReadHeadDelivery, type ReadHeadParent,
} from "../src/storage/read-head-parent.js";
import {captureReadHeadView, parseReadHeadView, validateCompletedReadHead} from "../src/storage/read-head-state.js";
import {
  applyHeadPrototype, initializeReadHeadParentPrototype, mutateParentPrototype, readHeadPrototype, readParentPrototype,
} from "./support/read-head-prototype.js";

function view(frontier: number, epoch = 0) {
  return parseReadHeadView({frontier, vector: TREE_PREFIXES.map((prefix, index) => ({
    prefix, snapshotSeq: index < 2 ? frontier : 0, directoryEpoch: index === 0 ? epoch : 0,
  }))});
}
async function fixture(count: number) {
  const graph = parseGraphId(`test-head-durable-${crypto.randomUUID()}`);
  if (!graph.ok) throw new Error("invalid fixture graph");
  const graphId = graph.value, parent = env.GRAPH_FACADES.getByName(coordinatorObjectName(graphId));
  const head = (member: number) => env.GRAPH_FACADES.getByName(`${coordinatorObjectName(graphId)}:test-head:${member}`);
  await initializeReadHeadParentPrototype(parent, graphId, view(0));
  const ack = async (delivery: ReadHeadDelivery, loseHeadReply = false) => {
    const applied = await applyHeadPrototype(head(delivery.member), delivery.command, loseHeadReply);
    expect(["applied", "already-applied"]).toContain(applied.outcome);
    return mutateParentPrototype(parent, state => acknowledgeReadHeadDelivery(state, delivery, applied.outcome));
  };
  const settle = async () => {
    let state = await readParentPrototype(parent);
    while (state.operation !== null) {
      const delivery = pendingReadHeadDeliveries(state)[0];
      if (delivery === undefined) throw new Error("pending fixture work has no command");
      state = await ack(delivery);
    }
    return state;
  };
  for (let n = 0; n < count; n++) {
    await mutateParentPrototype(parent, beginReadHeadJoin);
    await settle();
  }
  return {graphId, parent, head, ack, settle};
}
function first(parent: ReadHeadParent): ReadHeadDelivery {
  const delivery = pendingReadHeadDeliveries(parent)[0];
  if (delivery === undefined) throw new Error("missing pending fixture command");
  return delivery;
}

// These tests exercise real local SQLite/output gates and eviction through
// test-only adapters, NOT production parent routing, ledger recovery or alarms.
describe("replicated freshness-head SQLite/restart prototype", () => {
  it.each(["prepare", "freeze", "activate"] as const)("persists %s before its lost reply and replays identically after eviction", async phase => {
    const f = await fixture(1);
    let parent = await mutateParentPrototype(f.parent, state => beginReadHeadPublication(state, view(1)));
    while (parent.operation?.kind === "publication" && parent.operation.phase !== phase) parent = await f.ack(first(parent));
    const delivery = first(parent), head = f.head(delivery.member);
    expect(delivery.command.kind).toBe(phase);
    await expect(applyHeadPrototype(head, delivery.command, true)).rejects.toThrow("lost head acknowledgement");
    await evictDurableObject(head);
    const recovered = await readHeadPrototype(head);
    expect(recovered.mode).toBe(phase === "prepare" ? "preparing" : phase === "freeze" ? "frozen" : "serving");
    expect(captureReadHeadView(recovered, f.graphId)).toEqual(phase === "prepare" ? view(0) : phase === "freeze" ? null : view(1));
    expect(await readParentPrototype(f.parent)).toEqual(parent);
    const duplicate = await applyHeadPrototype(head, delivery.command);
    expect(duplicate.outcome).toBe("already-applied");
    expect(duplicate.state).toEqual(recovered);
    await mutateParentPrototype(f.parent, state => acknowledgeReadHeadDelivery(state, delivery, duplicate.outcome));
    const completed = await f.settle();
    expect(completed.view).toEqual(view(1));
    expect(captureReadHeadView(await readHeadPrototype(head), f.graphId)).toEqual(view(1));
  });

  it("atomically recovers canonical publication AND activation intent after a lost parent reply", async () => {
    const f = await fixture(3);
    let state = await mutateParentPrototype(f.parent, parent => beginReadHeadPublication(parent, view(1)));
    while (state.operation?.kind === "publication" && state.operation.phase === "prepare") state = await f.ack(first(state));
    while (pendingReadHeadDeliveries(state).length > 1) state = await f.ack(first(state));
    const lastFreeze = first(state);
    const applied = await applyHeadPrototype(f.head(lastFreeze.member), lastFreeze.command);
    await expect(mutateParentPrototype(f.parent,
      parent => acknowledgeReadHeadDelivery(parent, lastFreeze, applied.outcome), "after-commit",
    )).rejects.toThrow("lost parent acknowledgement");
    await evictDurableObject(f.parent);
    const recovered = await readParentPrototype(f.parent);
    expect(recovered.view).toEqual(view(1));
    expect(recovered.operation?.kind === "publication" && recovered.operation.phase).toBe("activate");
    for (const member of recovered.members) {
      await evictDurableObject(f.head(member));
      const head = await readHeadPrototype(f.head(member));
      expect(captureReadHeadView(head, f.graphId)).toBeNull();
      const changed = TREE_PREFIXES[0]!, unchanged = TREE_PREFIXES[2]!;
      expect(validateCompletedReadHead(head, f.graphId, [changed], view(0).vector.filter(owner => owner.prefix === changed)))
        .toEqual({kind: "canonical"});
      expect(validateCompletedReadHead(head, f.graphId, [unchanged], view(0).vector.filter(owner => owner.prefix === unchanged)))
        .toEqual({kind: "unchanged", snapshotSeq: 0});
    }
    // Reconcile the uncertain acknowledgement, not a new publication request.
    const duplicateAck = await mutateParentPrototype(f.parent,
      parent => acknowledgeReadHeadDelivery(parent, lastFreeze, applied.outcome));
    expect(duplicateAck).toEqual(recovered);
    const completed = await f.settle();
    expect(completed.view.frontier).toBe(1);
    expect(completed.operation).toBeNull();
    for (const member of completed.members) expect(captureReadHeadView(await readHeadPrototype(f.head(member)), f.graphId)).toEqual(view(1));
  });

  it("rolls back canonical-vector writes if journal persistence fails inside their transaction", async () => {
    const f = await fixture(2);
    let state = await mutateParentPrototype(f.parent, parent => beginReadHeadPublication(parent, view(1)));
    while (state.operation?.kind === "publication" && state.operation.phase === "prepare") state = await f.ack(first(state));
    while (pendingReadHeadDeliveries(state).length > 1) state = await f.ack(first(state));
    const lastFreeze = first(state);
    const applied = await applyHeadPrototype(f.head(lastFreeze.member), lastFreeze.command);
    await expect(mutateParentPrototype(f.parent,
      parent => acknowledgeReadHeadDelivery(parent, lastFreeze, applied.outcome), "before-journal",
    )).rejects.toThrow("before journal persistence");
    await evictDurableObject(f.parent);
    const recovered = await readParentPrototype(f.parent);
    expect(recovered).toEqual(state);
    await runInDurableObject(f.parent, (_instance, ctx) => {
      expect(ctx.storage.sql.exec<{frontier: number}>("SELECT frontier FROM graph_safe_frontier").one().frontier).toBe(0);
      expect(ctx.storage.sql.exec<{visible_seq: number}>("SELECT visible_seq FROM graph_safe_vector WHERE prefix = ?", TREE_PREFIXES[0]!).one().visible_seq).toBe(0);
    });
    expect((await f.ack(lastFreeze)).view).toEqual(view(1));
    expect((await f.settle()).operation).toBeNull();
  });

  it.each(["bootstrap", "activate"] as const)("recovers join %s from durable membership intent after a lost reply", async phase => {
    const f = await fixture(0);
    let parent = await mutateParentPrototype(f.parent, beginReadHeadJoin);
    if (phase === "activate") parent = await f.ack(first(parent));
    const delivery = first(parent), head = f.head(delivery.member);
    expect(delivery.command.kind).toBe(phase);
    await expect(applyHeadPrototype(head, delivery.command, true)).rejects.toThrow("lost head acknowledgement");
    await evictDurableObject(head);
    await evictDurableObject(f.parent);
    expect(await readParentPrototype(f.parent)).toEqual(parent);
    expect((await readHeadPrototype(head)).mode).toBe(phase === "bootstrap" ? "frozen" : "serving");
    expect((await f.settle()).members).toEqual([delivery.member]);
    expect(captureReadHeadView(await readHeadPrototype(head), f.graphId)).toEqual(view(0));
  });

  it("durably publishes without remote commands when no heads have joined", async () => {
    const f = await fixture(0);
    await mutateParentPrototype(f.parent, parent => beginReadHeadPublication(parent, view(1)));
    await evictDurableObject(f.parent);
    const recovered = await readParentPrototype(f.parent);
    expect(recovered.view).toEqual(view(1));
    expect(recovered.operation).toBeNull();
    expect(recovered.members).toEqual([]);
  });

  it("keeps retired stale routes non-serving across eviction and rejoins under a fresh identity", async () => {
    const f = await fixture(2), registered = await readParentPrototype(f.parent), retiring = registered.members[0]!;
    const retirement = await mutateParentPrototype(f.parent, parent => beginReadHeadRetirement(parent, retiring));
    const delivery = first(retirement), staleRoute = f.head(retiring);
    await expect(applyHeadPrototype(staleRoute, delivery.command, true)).rejects.toThrow("lost head acknowledgement");
    await evictDurableObject(staleRoute);
    expect((await readHeadPrototype(staleRoute)).mode).toBe("retired");
    expect((await readParentPrototype(f.parent)).members).toContain(retiring);
    await f.settle();
    await mutateParentPrototype(f.parent, parent => beginReadHeadPublication(parent, view(1, 1)));
    await f.settle();
    await mutateParentPrototype(f.parent, beginReadHeadJoin);
    const rejoined = await f.settle();
    expect(rejoined.members).not.toContain(retiring);
    expect(rejoined.view).toEqual(view(1, 1));
    expect(captureReadHeadView(await readHeadPrototype(staleRoute), f.graphId)).toBeNull();
    for (const member of rejoined.members) expect(captureReadHeadView(await readHeadPrototype(f.head(member)), f.graphId)).toEqual(view(1, 1));
  });
});
