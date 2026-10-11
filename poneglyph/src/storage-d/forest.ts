import { MAX_RETAINED_TRANSACTION_OUTCOMES } from "./constants.js";
import { prefixOfKey, coordinatorObjectName, type VirtualKey, type VirtualPrefix } from "./keys.js";

// Fixed independent roots for this candidate; each root retains expandable
// descendant routing. This is topology, not distribution across graph IDs.
export const TREE_DEPTH = 4;
export const TREE_PREFIXES = Object.freeze(Array.from({ length: 2 ** TREE_DEPTH }, (_, i) =>
  i.toString(2).padStart(TREE_DEPTH, "0") as VirtualPrefix));
export const TREE_OUTCOME_LIMIT = Math.floor(MAX_RETAINED_TRANSACTION_OUTCOMES / TREE_PREFIXES.length);
export function treeForKey(key: VirtualKey): VirtualPrefix { return prefixOfKey(key, TREE_DEPTH); }
export function treeCoordinatorName(graphId: string, prefix: VirtualPrefix): string {
  if (prefix.length !== TREE_DEPTH) throw new TypeError("expected an independent tree root");
  return `${coordinatorObjectName(graphId)}:tree:${prefix}`;
}
export function transactionCoordinatorName(graphId: string, txId: string): string {
  return `${coordinatorObjectName(graphId)}:transaction:${txId}`;
}
export type TreeSnapshot = Readonly<{
  prefix: VirtualPrefix; readId: string; snapshotSeq: number; directoryEpoch: number; expiresAtMs: number;
}>;
