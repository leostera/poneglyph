import {describe, expect, it} from "vitest";
import {parseFactBatch} from "../src/domain/fact.js";
import {parseParticipantBatch} from "../src/storage/protocol.js";

function fixture() {
  const batch = parseFactBatch({txId: "test:protocol", facts: [0, 1].map(() => ({source: "test:source", entity: "test:entity",
    field: "test:field", value: {type: "text", value: "same"}, retraction: false}))});
  if (!batch.ok) throw new Error("invalid protocol fixture");
  const fact = batch.value.facts[0]!;
  const entry = (index: number) => ({index, fact, virtualKey: "0".repeat(64)});
  return {input: {graphId: "example", shardPrefix: "0000", shardGeneration: 0, directoryEpoch: 0,
    txId: batch.value.txId, payloadHash: "1".repeat(64), statementTimeMs: 0, identityTimeMs: 0, commitSeq: 0,
    facts: [entry(0), entry(2)]}, entry};
}

describe("participant fact-index parsing", () => {
  it("preserves equal canonical events at distinct increasing journal indices", () => {
    const f = fixture(), result = parseParticipantBatch(f.input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("invalid fixture participant");
    expect(result.value.facts.map(({index}) => index)).toEqual([0, 2]);
    expect(result.value.facts[0]?.fact).toEqual(result.value.facts[1]?.fact);
  });

  it.each([[0, 0], [2, 1]])("rejects duplicate or out-of-order journal indices %i, %i", (first, second) => {
    const f = fixture(); f.input.facts = [f.entry(first), f.entry(second)];
    expect(parseParticipantBatch(f.input)).toEqual({ok: false, error: {
      path: "participant.facts[1].index", message: "expected a unique non-negative fact index",
    }});
  });
});
