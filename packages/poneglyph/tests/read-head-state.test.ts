import {describe, expect, it} from "vitest";
import {parseGraphId} from "../src/domain/graph-id.js";
import {TREE_PREFIXES} from "../src/storage/forest.js";
import {
  EMPTY_READ_HEAD, applyReadHeadCommand, captureReadHeadView, parseReadHeadCommand,
  parseReadHeadState, parseReadHeadView, validateCompletedReadHead, type ReadHeadCommand, type ReadHeadState, type ReadHeadView,
} from "../src/storage/read-head-state.js";

const parsedGraph = parseGraphId("test-read-head");
if (!parsedGraph.ok) throw new Error("invalid fixture graph");
const graph = parsedGraph.value;
const rawView = (frontier: number, sequence: number, epoch = 0) => ({frontier,
  vector: TREE_PREFIXES.map((prefix, index) => ({prefix, snapshotSeq: index < 2 ? sequence : 0, directoryEpoch: index === 0 ? epoch : 0})),
});
const view = (frontier: number, sequence: number, epoch = 0) => parseReadHeadView(rawView(frontier, sequence, epoch));
function command(kind: ReadHeadCommand["kind"], generation: number, snapshot?: ReadHeadView): ReadHeadCommand {
  return parseReadHeadCommand({kind, graphId: graph, generation, ...(snapshot ? {view: snapshot} : {})});
}
function installed(): ReadHeadState {
  const prepared = applyReadHeadCommand(EMPTY_READ_HEAD, command("bootstrap", 0, view(0, 0))).state;
  return applyReadHeadCommand(prepared, command("activate", 0)).state;
}

describe("experimental replicated freshness-head kernel", () => {
  it("serves the old complete view while preparing and no cached answer while frozen", () => {
    const zero = view(0, 0), one = view(1, 1);
    expect(captureReadHeadView(EMPTY_READ_HEAD, graph)).toBeNull();
    const bootstrap = applyReadHeadCommand(EMPTY_READ_HEAD, command("bootstrap", 0, zero));
    expect(bootstrap.outcome).toBe("applied");
    expect(captureReadHeadView(bootstrap.state, graph)).toBeNull();
    let state = applyReadHeadCommand(bootstrap.state, command("activate", 0)).state;
    expect(captureReadHeadView(state, graph)).toEqual(zero);
    state = applyReadHeadCommand(state, command("prepare", 1, one)).state;
    expect(captureReadHeadView(state, graph)).toEqual(zero);
    expect(applyReadHeadCommand(state, command("activate", 1)).outcome).toBe("conflict");
    state = applyReadHeadCommand(state, command("freeze", 1)).state;
    expect(captureReadHeadView(state, graph)).toBeNull();
    // The parent must now publish atomically; activation alone cannot prove it.
    state = applyReadHeadCommand(state, command("activate", 1)).state;
    expect(captureReadHeadView(state, graph)).toEqual(one);
    const delayedFreeze = applyReadHeadCommand(state, command("freeze", 1));
    expect(delayedFreeze.outcome).toBe("already-applied");
    expect(delayedFreeze.state).toBe(state);
    expect(captureReadHeadView(delayedFreeze.state, graph)).toEqual(one);
  });

  it("fences delayed activation and lost-reply redelivery across independent membership generations", () => {
    let state = installed();
    const first = [command("prepare", 1, view(1, 1)), command("freeze", 1), command("activate", 1)];
    for (const message of first) state = applyReadHeadCommand(state, message).state;
    state = applyReadHeadCommand(state, command("prepare", 7, view(2, 2))).state;
    state = applyReadHeadCommand(state, command("freeze", 7)).state;
    const frozen = state;
    for (const delayed of [...first, command("bootstrap", 0, view(0, 0))]) {
      const result = applyReadHeadCommand(state, delayed);
      expect(result.outcome).toBe("stale");
      expect(result.state).toBe(frozen);
      expect(captureReadHeadView(result.state, graph)).toBeNull();
    }
    // Actor recovery reconstructs durable pending work; there are no leases,
    // wall-clock expiry guesses, active RPC promises or volatile gate flags.
    state = parseReadHeadState(JSON.parse(JSON.stringify(state)));
    state = applyReadHeadCommand(state, command("activate", 7)).state;
    expect(captureReadHeadView(state, graph)).toEqual(view(2, 2));
    expect(applyReadHeadCommand(state, command("activate", 7)).outcome).toBe("already-applied");
  });

  it("binds a generation to the operation kind as well as its vector", () => {
    const bootstrap = installed();
    expect(applyReadHeadCommand(bootstrap, command("bootstrap", 0, view(0, 0))).outcome).toBe("already-applied");
    expect(applyReadHeadCommand(bootstrap, command("prepare", 0, view(0, 0))).outcome).toBe("conflict");
    expect(applyReadHeadCommand(bootstrap, command("freeze", 0)).outcome).toBe("conflict");
    const preparing = applyReadHeadCommand(bootstrap, command("prepare", 1, view(1, 1))).state;
    const frozen = applyReadHeadCommand(preparing, command("freeze", 1)).state;
    expect(applyReadHeadCommand(frozen, command("bootstrap", 1, view(1, 1))).outcome).toBe("conflict");
    const active = applyReadHeadCommand(frozen, command("activate", 1)).state;
    expect(applyReadHeadCommand(active, command("bootstrap", 1, view(1, 1))).outcome).toBe("conflict");
    expect(applyReadHeadCommand(active, command("prepare", 1, view(1, 1))).outcome).toBe("already-applied");
  });

  it("accepts only identical same-generation images and monotonic next publications", () => {
    const prepared = applyReadHeadCommand(installed(), command("prepare", 4, view(1, 1))).state;
    expect(applyReadHeadCommand(prepared, command("prepare", 4, view(1, 1))).outcome).toBe("already-applied");
    expect(applyReadHeadCommand(prepared, command("prepare", 4, view(1, 2))).outcome).toBe("conflict");
    expect(applyReadHeadCommand(prepared, command("prepare", 5, view(1, 1))).outcome).toBe("conflict");
    let active = applyReadHeadCommand(prepared, command("freeze", 4)).state;
    active = applyReadHeadCommand(active, command("activate", 4)).state;
    for (const next of [view(1, 1), view(3, 2), view(2, 0), view(2, 1)]) {
      expect(applyReadHeadCommand(active, command("prepare", 8, next)).outcome).toBe("conflict");
    }
    expect(applyReadHeadCommand(active, command("prepare", 8, view(2, 1, 1))).outcome).toBe("applied");
  });

  it("validates only projections unchanged on BOTH sides of a frozen publication", () => {
    const before = view(0, 0), after = view(1, 1);
    const preparing = applyReadHeadCommand(installed(), command("prepare", 1, after)).state;
    const frozen = applyReadHeadCommand(preparing, command("freeze", 1)).state;
    const unaffected = TREE_PREFIXES[2]!, changed = TREE_PREFIXES[0]!;
    const hint = (snapshot: ReadHeadView, prefix: string) => snapshot.vector.filter(owner => owner.prefix === prefix);
    expect(validateCompletedReadHead(frozen, graph, [unaffected], hint(before, unaffected))).toEqual({kind: "unchanged", snapshotSeq: 0});
    expect(validateCompletedReadHead(frozen, graph, [changed], hint(before, changed))).toEqual({kind: "canonical"});
    expect(validateCompletedReadHead(frozen, graph, [changed], hint(after, changed))).toEqual({kind: "canonical"});
    expect(validateCompletedReadHead(frozen, graph, TREE_PREFIXES, before.vector)).toEqual({kind: "canonical"});
    expect(() => validateCompletedReadHead(frozen, graph, [unaffected, changed], hint(before, unaffected))).toThrow();
    expect(() => validateCompletedReadHead(frozen, graph, [], [])).toThrow();
    const bootstrap = applyReadHeadCommand(EMPTY_READ_HEAD, command("bootstrap", 1, before)).state;
    expect(validateCompletedReadHead(bootstrap, graph, [unaffected], hint(before, unaffected))).toEqual({kind: "canonical"});

    const topologyPreparing = applyReadHeadCommand(installed(), command("prepare", 2, view(1, 0, 1))).state;
    const topologyFrozen = applyReadHeadCommand(topologyPreparing, command("freeze", 2)).state;
    expect(validateCompletedReadHead(topologyFrozen, graph, [changed], hint(before, changed))).toEqual({kind: "canonical"});
  });

  it("keeps retired stale routes permanently non-serving, without deleting durable objects", () => {
    const retired = applyReadHeadCommand(installed(), command("retire", 2)).state;
    expect(captureReadHeadView(retired, graph)).toBeNull();
    expect(applyReadHeadCommand(retired, command("activate", 0)).outcome).toBe("stale");
    expect(applyReadHeadCommand(retired, command("retire", 2)).outcome).toBe("already-applied");
    expect(applyReadHeadCommand(retired, command("bootstrap", 3, view(0, 0))).outcome).toBe("conflict");
    expect(parseReadHeadState(JSON.parse(JSON.stringify(retired)))).toEqual(retired);
  });

  it("binds both updates and captures to one graph, including after recovery", () => {
    const state = installed();
    const foreign = parseReadHeadCommand({kind: "retire", graphId: "another-graph", generation: 100});
    expect(applyReadHeadCommand(state, foreign)).toEqual({outcome: "conflict", state});
    const other = parseGraphId("another-graph");
    if (!other.ok) throw new Error("invalid fixture graph");
    expect(() => captureReadHeadView(state, other.value)).toThrow("identity mismatch");
  });

  it("parses full immutable vectors and rejects leases, malformed counters and corrupted checkpoints", () => {
    const input = rawView(0, 0), parsed = parseReadHeadView(input);
    input.vector[0]!.snapshotSeq = 99;
    expect(parsed.vector[0]!.snapshotSeq).toBe(0);
    expect(Object.isFrozen(parsed) && Object.isFrozen(parsed.vector) && parsed.vector.every(Object.isFrozen)).toBe(true);
    for (const raw of [null, {...rawView(0, 0), expiresAt: 123}, rawView(-1, 0), rawView(0, Infinity),
      {...rawView(0, 0), vector: rawView(0, 0).vector.slice(1)},
      {...rawView(0, 0), vector: Array.from({length: 16}, () => rawView(0, 0).vector[0])},
    ]) expect(() => parseReadHeadView(raw)).toThrow();
    for (const raw of [{kind: "activate", graphId: graph, generation: -1},
      {kind: "activate", graphId: graph, generation: .5},
      {kind: "activate", graphId: graph, generation: 1, leaseId: "not-permission"},
      {kind: "prepare", graphId: graph, generation: 1},
    ]) expect(() => parseReadHeadCommand(raw)).toThrow();
    for (const raw of [{mode: "serving", graphId: graph, generation: 0},
      {mode: "frozen", graphId: graph, generation: 1, previousView: view(0, 0), nextView: view(2, 2)},
      {mode: "preparing", graphId: graph, generation: 1, view: view(1, 1), nextView: view(2, 0)},
      {mode: "empty", view: view(0, 0)},
    ]) expect(() => parseReadHeadState(raw)).toThrow();
  });
});
