import { describe, expect, it } from "vitest";
import { parseReadIdentity, readIdentityMatches } from "../src/storage/read-identity.js";
import { TREE_PREFIXES } from "../src/storage/forest.js";

const a = TREE_PREFIXES[0]!, b = TREE_PREFIXES[1]!;
const identity = [{prefix: a, snapshotSeq: 7, directoryEpoch: 2}, {prefix: b, snapshotSeq: 1, directoryEpoch: 0}];
const vector = [{prefix: a, visible_seq: 7, directory_epoch: 2}, {prefix: b, visible_seq: 1, directory_epoch: 0}];

describe("completed result read identity", () => {
  it("requires exact selected owner revisions AND topology epochs", () => {
    const parsed = parseReadIdentity(identity, [a, b]);
    expect(readIdentityMatches(parsed, vector)).toBe(true);
    expect(readIdentityMatches(parsed, [{...vector[0]!, visible_seq: 8}, vector[1]!])).toBe(false);
    expect(readIdentityMatches(parsed, [{...vector[0]!, directory_epoch: 3}, vector[1]!])).toBe(false);
    expect(readIdentityMatches(parsed, vector.slice(1))).toBe(false);
    expect(readIdentityMatches(parsed, [...vector, {prefix: TREE_PREFIXES[2]!, visible_seq: 100, directory_epoch: 5}])).toBe(true);
    expect(Object.isFrozen(parsed) && parsed.every(Object.isFrozen)).toBe(true);
  });

  it("rejects incomplete, duplicate, foreign, malformed and lease-bearing identities", () => {
    for (const input of [undefined, [], [identity[0]], [identity[0], identity[0]],
      [identity[0], {...identity[1], prefix: TREE_PREFIXES[2]}],
      [identity[0], {...identity[1], snapshotSeq: -1}],
      [identity[0], {...identity[1], directoryEpoch: 1.5}],
      [identity[0], {...identity[1], readId: "not-a-capability"}],
    ]) expect(() => parseReadIdentity(input, [a, b])).toThrow();
  });
});
