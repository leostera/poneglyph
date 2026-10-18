import { isRecord } from "../domain/result.js";
import { TREE_PREFIXES } from "./forest.js";
import { parseVirtualPrefix, type VirtualPrefix } from "./keys.js";

// Immutable MVCC/topology identity, not a lease, freshness authority, or token
// granting access. Only a fresh authoritative comparison can validate reuse.
export type ReadIdentity = readonly Readonly<{prefix: VirtualPrefix; snapshotSeq: number; directoryEpoch: number}>[];

export function parseReadIdentity(input: unknown, expected: readonly VirtualPrefix[]): ReadIdentity {
  if (!Array.isArray(input) || input.length !== expected.length || input.length === 0 || input.length > TREE_PREFIXES.length) {
    throw new Error("invalid read identity coverage");
  }
  const seen = new Set<string>();
  const identity = input.map(item => {
    if (!isRecord(item) || Object.keys(item).some(key => !["prefix", "snapshotSeq", "directoryEpoch"].includes(key))) {
      throw new Error("invalid read identity component");
    }
    const prefix = parseVirtualPrefix(item["prefix"]);
    const snapshotSeq = item["snapshotSeq"], directoryEpoch = item["directoryEpoch"];
    if (!prefix.ok || !expected.includes(prefix.value) || seen.has(prefix.value) ||
        !isCounter(snapshotSeq) || !isCounter(directoryEpoch)) throw new Error("invalid read identity component");
    seen.add(prefix.value);
    return Object.freeze({prefix: prefix.value, snapshotSeq, directoryEpoch});
  });
  return Object.freeze(identity);
}

export function readIdentityMatches(
  identity: ReadIdentity,
  vector: readonly Readonly<{prefix: string; visible_seq: number; directory_epoch: number}>[],
): boolean {
  return identity.every(component => vector.some(owner => owner.prefix === component.prefix &&
    owner.visible_seq === component.snapshotSeq && owner.directory_epoch === component.directoryEpoch));
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
