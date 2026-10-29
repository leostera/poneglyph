import { describe, expect, it } from "vitest";
import { CallRate, DEFAULT_SPLIT_POLICY, splitReason } from "../src/storage/split-policy.js";
import { TREE_DEPTH } from "../src/storage/forest.js";

describe("shard split policy", () => {
  const policy = {...DEFAULT_SPLIT_POLICY, callsPerSecond: 10, windowSeconds: 2, sizeBytes: 1_000};

  it("averages calls over finished seconds and ignores objects younger than the window", () => {
    const rate = new CallRate(0);
    for (let i = 0; i < 30; i++) rate.record(1_000 + i);
    for (let i = 0; i < 10; i++) rate.record(2_000 + i);
    expect(rate.average(2, 1_500)).toBe(0);
    expect(rate.average(2, 3_000)).toBe(20);
    expect(rate.average(2, 4_000)).toBe(5);
  });

  it("splits on sustained call rate or size, never past the maximum depth", () => {
    const busy = new CallRate(0);
    for (let i = 0; i < 50; i++) {busy.record(1_000 + i); busy.record(2_000 + i);}
    expect(splitReason(policy, TREE_DEPTH, busy, 0, 3_000)).toBe("call-rate");
    expect(splitReason(policy, TREE_DEPTH, new CallRate(0), 1_000, 3_000)).toBe("size");
    expect(splitReason(policy, TREE_DEPTH, new CallRate(0), 999, 3_000)).toBeUndefined();
    expect(splitReason(policy, policy.maxDepth, busy, 1_000, 3_000)).toBeUndefined();
  });
});
