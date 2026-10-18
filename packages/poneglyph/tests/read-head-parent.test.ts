import {describe, expect, it} from "vitest";
import {parseGraphId} from "../src/domain/graph-id.js";
import {TREE_PREFIXES} from "../src/storage/forest.js";
import {
  acknowledgeReadHeadDelivery, beginReadHeadJoin, beginReadHeadPublication, beginReadHeadRetirement,
  createReadHeadParent, parseReadHeadParent, pendingReadHeadDeliveries, type ReadHeadDelivery, type ReadHeadParent,
} from "../src/storage/read-head-parent.js";
import {
  EMPTY_READ_HEAD, applyReadHeadCommand, captureReadHeadView, parseReadHeadState, parseReadHeadView,
  validateCompletedReadHead, type ReadHeadState, type ReadHeadView,
} from "../src/storage/read-head-state.js";

const graph = parseGraphId("test-read-head-parent");
if (!graph.ok) throw new Error("invalid fixture graph");
const graphId = graph.value;
function view(frontier: number, changed = [0, 1]): ReadHeadView {
  return parseReadHeadView({frontier, vector: TREE_PREFIXES.map((prefix, index) => ({
    prefix, snapshotSeq: changed.includes(index) ? frontier : 0, directoryEpoch: 0,
  }))});
}
const fresh = () => createReadHeadParent(graphId, view(0));
const checkpoint = (parent: ReadHeadParent) => parseReadHeadParent(JSON.parse(JSON.stringify(parent)));
const headCheckpoint = (head: ReadHeadState) => parseReadHeadState(JSON.parse(JSON.stringify(head)));
function first(parent: ReadHeadParent): ReadHeadDelivery {
  const delivery = pendingReadHeadDeliveries(parent)[0];
  if (delivery === undefined) throw new Error("no pending fixture work");
  return delivery;
}
function settle(parent: ReadHeadParent, heads: Map<number, ReadHeadState>): ReadHeadParent {
  while (parent.operation !== null) {
    const delivery = first(parent);
    const applied = applyReadHeadCommand(heads.get(delivery.member) ?? EMPTY_READ_HEAD, delivery.command);
    expect(["applied", "already-applied"]).toContain(applied.outcome);
    heads.set(delivery.member, headCheckpoint(applied.state));
    parent = checkpoint(acknowledgeReadHeadDelivery(parent, delivery, applied.outcome));
  }
  return parent;
}
function registered(count: number): {parent: ReadHeadParent; heads: Map<number, ReadHeadState>} {
  let parent = fresh();
  const heads = new Map<number, ReadHeadState>();
  for (let n = 0; n < count; n++) parent = settle(beginReadHeadJoin(parent), heads);
  return {parent, heads};
}

/** Independent projection comparison: never use the kernel's matching helper. */
function assertCurrent(parent: ReadHeadParent, heads: Map<number, ReadHeadState>, history: readonly ReadHeadView[]): void {
  for (const head of heads.values()) {
    const captured = captureReadHeadView(head, graphId);
    if (captured !== null) expect(captured).toEqual(parent.view);
    for (const prior of history) {
      for (const indexes of [[0], [2], [0, 1], [0, 2]]) {
        const scope = indexes.map(index => TREE_PREFIXES[index]!);
        const hint = prior.vector.filter(owner => scope.includes(owner.prefix));
        const result = validateCompletedReadHead(head, graphId, scope, hint);
        if (result.kind === "unchanged") {
          for (const owner of hint) {
            const canonical = parent.view.vector.find(item => item.prefix === owner.prefix);
            expect(canonical?.snapshotSeq).toBe(owner.snapshotSeq);
            expect(canonical?.directoryEpoch).toBe(owner.directoryEpoch);
          }
        }
      }
    }
  }
}

describe("experimental durable read-head parent journal kernel", () => {
  it("registers only frozen bootstraps and completes a join only after activation", () => {
    let parent = beginReadHeadJoin(fresh());
    const delivery = first(parent);
    expect(parent.members).toEqual([]);
    expect(delivery.command.kind).toBe("bootstrap");
    const bootstrapped = applyReadHeadCommand(EMPTY_READ_HEAD, delivery.command);
    expect(captureReadHeadView(bootstrapped.state, graphId)).toBeNull();
    parent = acknowledgeReadHeadDelivery(parent, delivery, bootstrapped.outcome);
    expect(parent.members).toEqual([1]);
    expect(parent.operation).toEqual({kind: "join", phase: "activate", member: 1});
    const activation = first(parent);
    const activated = applyReadHeadCommand(bootstrapped.state, activation.command);
    expect(captureReadHeadView(activated.state, graphId)).toEqual(parent.view);
    parent = acknowledgeReadHeadDelivery(parent, activation, activated.outcome);
    expect(parent.operation).toBeNull();
  });

  it("publishes only after EVERY freeze ack, then waits for EVERY activation ack", () => {
    const fixture = registered(3);
    let parent = beginReadHeadPublication(fixture.parent, view(1));
    const old = parent.view;
    while (parent.operation?.kind === "publication" && parent.operation.phase === "prepare") {
      const delivery = first(parent);
      const applied = applyReadHeadCommand(fixture.heads.get(delivery.member)!, delivery.command);
      fixture.heads.set(delivery.member, applied.state);
      parent = acknowledgeReadHeadDelivery(parent, delivery, applied.outcome);
      expect(parent.view).toEqual(old);
    }
    const frozen = pendingReadHeadDeliveries(parent);
    expect(frozen).toHaveLength(3);
    for (const [index, delivery] of frozen.entries()) {
      const applied = applyReadHeadCommand(fixture.heads.get(delivery.member)!, delivery.command);
      fixture.heads.set(delivery.member, applied.state);
      parent = acknowledgeReadHeadDelivery(parent, delivery, applied.outcome);
      expect(parent.view).toEqual(index < 2 ? old : view(1));
    }
    expect(parent.operation?.kind === "publication" && parent.operation.phase).toBe("activate");
    expect([...fixture.heads.values()].every(head => captureReadHeadView(head, graphId) === null)).toBe(true);
    parent = settle(parent, fixture.heads);
    expect(parent.operation).toBeNull();
    assertCurrent(parent, fixture.heads, [old, view(1)]);
  });

  it("recovers exact work after remote apply/lost ack and rejects duplicates from older phases", () => {
    const fixture = registered(2);
    let parent = beginReadHeadPublication(fixture.parent, view(1));
    const delayed: ReadHeadDelivery[] = [];
    while (parent.operation !== null) {
      const delivery = first(parent);
      delayed.push(delivery);
      const before = checkpoint(parent);
      const applied = applyReadHeadCommand(fixture.heads.get(delivery.member)!, delivery.command);
      fixture.heads.set(delivery.member, headCheckpoint(applied.state));
      // Reply is lost; reconstruct both actors and redeliver the exact message.
      parent = checkpoint(parent);
      expect(parent).toEqual(before);
      expect(first(parent)).toEqual(delivery);
      const repeated = applyReadHeadCommand(fixture.heads.get(delivery.member)!, delivery.command);
      expect(repeated.outcome).toBe("already-applied");
      parent = checkpoint(acknowledgeReadHeadDelivery(parent, delivery, repeated.outcome));
      for (const old of delayed) expect(acknowledgeReadHeadDelivery(parent, old, "applied")).toBe(parent);
      assertCurrent(parent, fixture.heads, [view(0), view(1)]);
    }
  });

  it("serializes membership/publication and ignores failed, foreign or mismatched acknowledgements", () => {
    const fixture = registered(1);
    const parent = beginReadHeadPublication(fixture.parent, view(1)), delivery = first(parent);
    for (const start of [() => beginReadHeadJoin(parent), () => beginReadHeadRetirement(parent, 1),
      () => beginReadHeadPublication(parent, view(2))]) expect(start).toThrow("pending work");
    for (const outcome of [undefined, {}, "conflict", "stale", "success"]) {
      expect(acknowledgeReadHeadDelivery(parent, delivery, outcome)).toBe(parent);
    }
    const foreign = parseGraphId("test-other-head-parent");
    if (!foreign.ok) throw new Error("invalid fixture graph");
    for (const changed of [{...delivery, member: 2}, {...delivery, command: {...delivery.command, graphId: foreign.value}},
      {...delivery, command: {...delivery.command, generation: parent.generation + 1}},
      {...delivery, command: {...delivery.command, kind: "freeze" as const}},
      {...delivery, command: {...delivery.command, kind: "prepare" as const, view: view(1, [0])}},
    ]) expect(acknowledgeReadHeadDelivery(parent, changed, "applied")).toBe(parent);
  });

  it("retires stale routes durably before dropping membership and never reuses their identity", () => {
    const fixture = registered(2), retiredMember = fixture.parent.members[0]!;
    let parent = beginReadHeadRetirement(fixture.parent, retiredMember);
    const retirement = first(parent);
    const retired = applyReadHeadCommand(fixture.heads.get(retiredMember)!, retirement.command);
    fixture.heads.set(retiredMember, retired.state);
    expect(parent.members).toContain(retiredMember);
    parent = checkpoint(acknowledgeReadHeadDelivery(parent, retirement, retired.outcome));
    expect(parent.members).not.toContain(retiredMember);
    parent = settle(beginReadHeadPublication(parent, view(1)), fixture.heads);
    parent = settle(beginReadHeadJoin(parent), fixture.heads);
    expect(parent.members).not.toContain(retiredMember);
    expect(fixture.heads.get(retiredMember)?.mode).toBe("retired");
    assertCurrent(parent, fixture.heads, [view(0), view(1)]);
  });

  it("publishes with no heads without introducing a remote gate", () => {
    const parent = beginReadHeadPublication(fresh(), view(1));
    expect(parent.operation).toBeNull();
    expect(parent.view).toEqual(view(1));
    expect(pendingReadHeadDeliveries(parent)).toEqual([]);
  });

  it("rejects corrupt checkpoints, sparse membership, regressed views and generation exhaustion", () => {
    const parent = registered(2).parent;
    const pending = beginReadHeadPublication(parent, view(1));
    const sparse: unknown[] = new Array(2); sparse[0] = 1;
    for (const raw of [null, {...parent, extra: true}, {...parent, generation: -1}, {...parent, members: sparse},
      {...parent, members: [1, 1]}, {...parent, members: [1, 99]}, {...parent, operation: {kind: "retire", member: 99}},
      {...parent, operation: {kind: "join", phase: "bootstrap", member: 1}},
      {...pending, view: view(1)}, {...pending, operation: {...pending.operation, acknowledged: [1, 2]}},
      {...pending, operation: {...pending.operation, phase: "activate"}},
      {...pending, operation: {...pending.operation, acknowledged: [99]}},
    ]) expect(() => parseReadHeadParent(raw)).toThrow();
    for (const next of [view(0), view(2), view(1, [])]) expect(() => beginReadHeadPublication(parent, next)).toThrow();
    const exhausted = parseReadHeadParent({...parent, generation: Number.MAX_SAFE_INTEGER});
    expect(() => beginReadHeadJoin(exhausted)).toThrow("exhausted");
    expect(() => beginReadHeadRetirement(parent, 99)).toThrow("not registered");
    const parsed = checkpoint(parent);
    expect(Object.isFrozen(parsed) && Object.isFrozen(parsed.members) && Object.isFrozen(parsed.view.vector)).toBe(true);
  });

  it("keeps every accepted cached projection current across 100 deterministic delivery/recovery schedules", () => {
    // These are fault schedules for ONE architecture, not 100 architecture rounds.
    for (let seed = 1; seed <= 100; seed++) {
      let random = seed;
      const choose = (size: number) => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % size; };
      const fixture = registered(4), history = [view(0)];
      let parent = fixture.parent;
      for (let revision = 1; revision <= 4; revision++) {
        const next = view(revision); history.push(next);
        parent = beginReadHeadPublication(parent, next);
        while (parent.operation !== null) {
          const pending = pendingReadHeadDeliveries(parent), delivery = pending[choose(pending.length)]!;
          const result = applyReadHeadCommand(fixture.heads.get(delivery.member)!, delivery.command);
          fixture.heads.set(delivery.member, headCheckpoint(result.state));
          assertCurrent(parent, fixture.heads, history);
          if (choose(3) === 0) {
            const duplicate = applyReadHeadCommand(fixture.heads.get(delivery.member)!, delivery.command);
            expect(duplicate.outcome).toBe("already-applied");
          }
          parent = checkpoint(parent);
          parent = checkpoint(acknowledgeReadHeadDelivery(parent, delivery, result.outcome));
          assertCurrent(parent, fixture.heads, history);
        }
        if (revision === 2) {
          parent = settle(beginReadHeadRetirement(parent, parent.members[choose(parent.members.length)]!), fixture.heads);
          parent = settle(beginReadHeadJoin(parent), fixture.heads);
        }
      }
    }
  }, 20_000);
});
