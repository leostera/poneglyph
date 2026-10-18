import {describe, expect, it} from "vitest";
import {parseFactBatch} from "../src/domain/fact.js";
import {isRecord} from "../src/domain/result.js";
import type {StorageEnv} from "../src/storage/environment.js";
import {planBatch, parseWritePlan} from "../src/storage/plan.js";

// Fixed SHA-256(example + NUL + entity) fixtures, independent of planner output.
const keyA = "4dfa5b603fad56121892929a3409dd880912ce929044cb467196d454e7a86719";
const keyB = "d25995221fb6eb8c4a315ed64518d81181a258767340a62db920c702dc3f17b2";
const key37 = "401320650c5658a5432612f66f266bad06f1cd78c90faae145118878ead825fe";

type RouteCall = {prefix: string; directoryEpoch: number; virtualKey: string};
function fixture(mode: "leaf" | "split" | "before-split" = "leaf") {
  const parsed = parseFactBatch({txId: "test:planner", facts: ["b", "a", "a", "37", "b"].map((suffix, index) => ({
    source: "test:source", entity: `test:plan:${suffix}`, field: "test:field",
    value: {type: "text", value: String(index)}, retraction: false,
  }))});
  if (!parsed.ok) throw new Error("invalid fixture batch");
  const routeCalls: RouteCall[] = [], directoryCalls: string[] = [];
  const unused = {getByName() {throw new Error("unexpected namespace access");}};
  const env: StorageEnv = {
    GRAPH_FACADES: unused, GRAPH_LEDGERS: unused, GRAPH_TREES: unused,
    GRAPH_SHARDS: {getByName() {return {async fetch(input, init) {
      expect(String(input)).toBe("https://shard.internal/_route");
      const body: unknown = JSON.parse(String(init?.body));
      if (!isRecord(body) || typeof body["prefix"] !== "string" || typeof body["directoryEpoch"] !== "number" || typeof body["virtualKey"] !== "string") {
        throw new Error("invalid fixture route request");
      }
      const prefix = body["prefix"];
      routeCalls.push({prefix, directoryEpoch: body["directoryEpoch"], virtualKey: body["virtualKey"]});
      if (prefix === "0100" && mode !== "leaf") {
        return Response.json({kind: "router", prefix, generation: 3, splitEpoch: 7, children: ["01000", "01001"], retired: false});
      }
      const generations: Record<string, number> = {"0100": 2, "1101": 3, "01001": 4, "01000": 5};
      const generation = generations[prefix];
      if (generation === undefined) throw new Error("unexpected fixture prefix");
      return Response.json({kind: "leaf", prefix, generation});
    }};}},
  };
  const ownerEpoch = mode === "before-split" ? 6 : 7;
  const owners = [
    {prefix: "0100", directoryEpoch: ownerEpoch, visibleSeq: 13, reservationTicket: 0, publicationSeq: 0, entities: ["test:plan:37", "test:plan:a"]},
    {prefix: "1101", directoryEpoch: 9, visibleSeq: 17, reservationTicket: 0, publicationSeq: 0, entities: ["test:plan:b"]},
  ];
  const directory = async (prefix: string) => {
    directoryCalls.push(prefix);
    const owner = owners.find(owner => owner.prefix === prefix);
    if (!owner) throw new Error("unexpected fixture owner");
    return {directoryEpoch: owner.directoryEpoch, visibleSeq: owner.visibleSeq};
  };
  return {env, batch: parsed.value, directory, owners, routeCalls, directoryCalls, ownerEpoch};
}

const unsplitParticipants = [
  {address: {prefix: "1101", generation: 3}, owner: "1101", entries: [{index: 0, virtualKey: keyB}, {index: 4, virtualKey: keyB}]},
  {address: {prefix: "0100", generation: 2}, owner: "0100", entries: [{index: 1, virtualKey: keyA}, {index: 2, virtualKey: keyA}, {index: 3, virtualKey: key37}]},
];

describe("write planner", () => {
  it("keeps sorted owners, unique sorted entities, first-encounter participants and every fact index", async () => {
    const f = fixture();
    const plan = await planBatch(f.env, "example", f.batch, f.directory);
    expect(plan).toEqual({owners: f.owners, participants: unsplitParticipants});
    expect(f.directoryCalls).toEqual(["0100", "1101"]);
    expect(f.routeCalls).toEqual([
      {prefix: "1101", directoryEpoch: 9, virtualKey: keyB},
      {prefix: "0100", directoryEpoch: 7, virtualKey: keyA},
      {prefix: "0100", directoryEpoch: 7, virtualKey: key37},
    ]);
    expect(await parseWritePlan(JSON.stringify(plan), "example", f.batch, "optional")).toEqual(plan);
  });

  it("groups physical split leaves without losing logical-owner or fact-index bindings", async () => {
    const f = fixture("split");
    const plan = await planBatch(f.env, "example", f.batch, f.directory);
    expect(plan).toEqual({owners: f.owners, participants: [
      unsplitParticipants[0],
      {address: {prefix: "01001", generation: 4}, owner: "0100", entries: [{index: 1, virtualKey: keyA}, {index: 2, virtualKey: keyA}]},
      {address: {prefix: "01000", generation: 5}, owner: "0100", entries: [{index: 3, virtualKey: key37}]},
    ]});
    expect(f.routeCalls.map(call => call.prefix)).toEqual(["1101", "0100", "01001", "0100", "01000"]);
    expect(await parseWritePlan(JSON.stringify(plan), "example", f.batch, "optional")).toEqual(plan);
  });

  it("routes the owner's earlier directory epoch to the retained parent generation", async () => {
    const f = fixture("before-split");
    expect(await planBatch(f.env, "example", f.batch, f.directory)).toEqual({owners: f.owners, participants: unsplitParticipants});
    expect(f.routeCalls).toEqual([
      {prefix: "1101", directoryEpoch: 9, virtualKey: keyB},
      {prefix: "0100", directoryEpoch: 6, virtualKey: keyA},
      {prefix: "0100", directoryEpoch: 6, virtualKey: key37},
    ]);
  });

  it("does not route when an owner snapshot is unavailable", async () => {
    const f = fixture(), failure = new Error("controlled metadata failure");
    await expect(planBatch(f.env, "example", f.batch, async () => {throw failure;})).rejects.toBe(failure);
    expect(f.routeCalls).toEqual([]);
  });

  it("rejects an invalid journal graph before directory I/O", async () => {
    const f = fixture();
    await expect(planBatch(f.env, "bad graph id", f.batch, f.directory)).rejects.toThrow("corrupt journal graph");
    expect(f.directoryCalls).toEqual([]);
    expect(f.routeCalls).toEqual([]);
  });
});
