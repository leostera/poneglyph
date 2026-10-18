import {describe, expect, it} from "vitest";
import {decisionContext, parseDecisionControl} from "../src/storage/decision-control.js";

function fixture() {
  return {graphId: "example", shardPrefix: "0100", shardGeneration: 2, directoryEpoch: 7,
    txId: "test:decision", payloadHash: "0".repeat(64), commitSeq: 9, statementTimeMs: 13, identityTimeMs: 11};
}

describe("shard decision-control boundary", () => {
  it("returns a detached immutable control without non-context input fields", () => {
    const input = {...fixture(), facts: ["not part of the control"]};
    const result = parseDecisionControl(input);
    expect(result).toEqual({ok: true, value: fixture()});
    if (!result.ok) throw new Error("invalid fixture control");
    input.commitSeq = 100;
    expect(result.value.commitSeq).toBe(9);
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it.each([null, [], "control", 1])("rejects non-object controls: %j", input => {
    expect(parseDecisionControl(input)).toEqual({ok: false, error: {path: "decision", message: "expected a commit object"}});
  });

  it.each([
    {statementTimeMs: -1}, {statementTimeMs: 0.5}, {statementTimeMs: "13"},
    {identityTimeMs: undefined}, {identityTimeMs: Infinity}, {identityTimeMs: Number.MAX_SAFE_INTEGER + 1},
  ])("rejects invalid decision timestamps: %j", invalid => {
    expect(parseDecisionControl({...fixture(), ...invalid})).toEqual({ok: false, error: {path: "decision", message: "invalid decision timestamps"}});
  });

  it("preserves timestamp-error precedence when other fields are also malformed", () => {
    expect(parseDecisionControl({graphId: false, identityTimeMs: -1})).toEqual({ok: false, error: {path: "decision", message: "invalid decision timestamps"}});
  });

  it.each([
    {graphId: "bad graph id"}, {shardPrefix: "0200"}, {shardGeneration: -1}, {directoryEpoch: "7"},
    {txId: ""}, {payloadHash: "A".repeat(64)}, {payloadHash: "0".repeat(63)},
    {commitSeq: NaN}, {commitSeq: Number.MAX_SAFE_INTEGER + 1},
  ])("rejects invalid commit identities/counters: %j", invalid => {
    expect(parseDecisionControl({...fixture(), ...invalid})).toEqual({ok: false, error: {path: "decision", message: "invalid commit request"}});
  });

  it.each([0, Number.MAX_SAFE_INTEGER])("retains the existing non-negative safe-integer bounds: %s", value => {
    const input = {...fixture(), shardGeneration: value, directoryEpoch: value, commitSeq: value, statementTimeMs: value, identityTimeMs: value};
    expect(parseDecisionControl(input)).toEqual({ok: true, value: input});
  });

  it("preserves exact persisted context bytes regardless of input order or extra facts", () => {
    const input = Object.fromEntries(Object.entries(fixture()).reverse());
    const result = parseDecisionControl(input);
    if (!result.ok) throw new Error("invalid fixture control");
    const withFacts = {...result.value, facts: ["ignored"]};
    expect(decisionContext(withFacts)).toBe('{"graphId":"example","shardPrefix":"0100","shardGeneration":2,"directoryEpoch":7,"txId":"test:decision","payloadHash":"0000000000000000000000000000000000000000000000000000000000000000","commitSeq":9,"statementTimeMs":13,"identityTimeMs":11}');
  });
});
