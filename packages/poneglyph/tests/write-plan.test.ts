import {describe, expect, it} from "vitest";
import {parseFactBatch} from "../src/domain/fact.js";
import {treeForKey} from "../src/storage/forest.js";
import {virtualKeyForEntity} from "../src/storage/keys.js";
import {parseWritePlan} from "../src/storage/plan.js";

const graphId = "example";
async function fixture() {
  const parsed = parseFactBatch({txId: "test:plan", facts: ["a", "b"].map(value => ({
    source: "test:source", entity: "test:e", field: "test:field", value: {type: "text", value}, retraction: false,
  }))});
  if (!parsed.ok) throw new Error("Invalid fixture batch");
  const key = await virtualKeyForEntity(graphId, "test:e"), prefix = treeForKey(key);
  const owner = {prefix, entities: ["test:e"], directoryEpoch: 0, visibleSeq: 0, reservationTicket: 1, publicationSeq: 0};
  const participant = {address: {prefix, generation: 0}, owner: prefix,
    entries: [{index: 0, virtualKey: String(key)}, {index: 1, virtualKey: String(key)}]};
  return {batch: parsed.value, owner, participant, plan: {owners: [owner], participants: [participant]}};
}

describe("durable write-plan boundary", () => {
  it("preserves the stored shape and every fact's index", async () => {
    const {batch, plan} = await fixture();
    expect(await parseWritePlan(JSON.stringify(plan), graphId, batch, "required")).toEqual(plan);
  });

  it("makes the partial-reservation recovery requirement explicit", async () => {
    const {batch, plan, owner} = await fixture();
    owner.reservationTicket = 0;
    await expect(parseWritePlan(JSON.stringify(plan), graphId, batch, "optional")).resolves.toEqual(plan);
    await expect(parseWritePlan(JSON.stringify(plan), graphId, batch, "required")).rejects.toThrow("invalid durable/control integer");
  });

  it("rejects missing facts rather than recovering a partial batch", async () => {
    const {batch, plan, participant} = await fixture();
    participant.entries.pop();
    await expect(parseWritePlan(JSON.stringify(plan), graphId, batch, "required")).rejects.toThrow("journal partition lost facts");
  });

  it("rejects duplicate or out-of-range indices", async () => {
    const {batch, plan, participant} = await fixture();
    participant.entries[1]!.index = 0;
    await expect(parseWritePlan(JSON.stringify(plan), graphId, batch, "required")).rejects.toThrow("unordered journal partition");
    participant.entries[1]!.index = 2;
    await expect(parseWritePlan(JSON.stringify(plan), graphId, batch, "required")).rejects.toThrow("incomplete/duplicate journal partition");
  });

  it("binds the key to the graph and exact canonical entity, not just its owner prefix", async () => {
    const {batch, plan, participant} = await fixture();
    const entry = participant.entries[0]!;
    entry.virtualKey = entry.virtualKey.slice(0, -1) + (entry.virtualKey.endsWith("0") ? "1" : "0");
    await expect(parseWritePlan(JSON.stringify(plan), graphId, batch, "required")).rejects.toThrow("journal key binding mismatch");
  });

  it("rejects duplicate physical and owner partitions", async () => {
    const {batch, plan, owner, participant} = await fixture();
    plan.owners.push(owner);
    await expect(parseWritePlan(JSON.stringify(plan), graphId, batch, "required")).rejects.toThrow("invalid owner partition");
    plan.owners.pop();
    plan.participants.push(participant);
    await expect(parseWritePlan(JSON.stringify(plan), graphId, batch, "required")).rejects.toThrow("invalid physical partition");
  });

  it("rejects duplicate, unordered or unbound owner entity sets", async () => {
    const {batch, plan, owner} = await fixture();
    owner.entities.push("test:e");
    await expect(parseWritePlan(JSON.stringify(plan), graphId, batch, "required")).rejects.toThrow("unordered owner entities");
    owner.entities = ["test:z", "test:e"];
    await expect(parseWritePlan(JSON.stringify(plan), graphId, batch, "required")).rejects.toThrow("unordered owner entities");
    owner.entities = ["test:e", "test:z"];
    await expect(parseWritePlan(JSON.stringify(plan), graphId, batch, "required")).rejects.toThrow("journal entity-set binding mismatch");
  });
});
