import { MAX_RETAINED_TRANSACTION_OUTCOMES } from "./constants.js";
import { isRecord } from "../domain/result.js";
import { sha256Hex } from "./http.js";
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
export const LEDGER_BUCKETS = Object.freeze(Array.from({length: 16}, (_, i) => i.toString(16)));
export const LEDGER_OUTCOME_LIMIT = Math.floor(MAX_RETAINED_TRANSACTION_OUTCOMES / LEDGER_BUCKETS.length);
export const LEDGER_RECOVERY_DELAY_MS = 5_000;

// RFD0010 experiment: graphs whose ID starts with this prefix spread their
// transactions over 64 ledgers (buckets "00".."3f"); every other graph keeps
// the 16 single-digit buckets, so existing tokens and IDs route unchanged.
const WIDE_LEDGER_GRAPH_PREFIX = "bench-l64-";
const WIDE_LEDGER_BUCKETS = Object.freeze(Array.from({length: 64}, (_, i) => i.toString(16).padStart(2, "0")));
export function ledgerBucketsForGraph(graphId: string): readonly string[] {
  return graphId.startsWith(WIDE_LEDGER_GRAPH_PREFIX) ? WIDE_LEDGER_BUCKETS : LEDGER_BUCKETS;
}
export function isLedgerBucket(graphId: string, bucket: string): boolean { return ledgerBucketsForGraph(graphId).includes(bucket); }
function bucketForDigest(graphId: string, digest: string): string {
  const buckets = ledgerBucketsForGraph(graphId);
  return buckets.length === 16 ? digest.slice(0, 1) : buckets[parseInt(digest.slice(0, 2), 16) % buckets.length]!;
}

export function ledgerCoordinatorName(graphId: string, bucket: string): string {
  if (!isLedgerBucket(graphId, bucket)) throw new TypeError("invalid ledger bucket");
  return `${coordinatorObjectName(graphId)}:ledger:${bucket}`;
}
export async function ledgerBucketForRequestToken(graphId: string, token: string): Promise<string> {
  return bucketForDigest(graphId, await sha256Hex(`${graphId}\u0000${token}`));
}

export async function ledgerBucketForTransactionId(graphId: string, txId: string): Promise<string> {
  const tokenRoutedBucket = /^poneglyph:tx:token:([0-9a-f]{1,2}):[0-9a-f-]{36}$/.exec(txId)?.[1];
  return tokenRoutedBucket ?? bucketForDigest(graphId, await sha256Hex(txId));
}

export async function transactionCoordinatorName(graphId: string, txId: string): Promise<string> {
  return ledgerCoordinatorName(graphId, await ledgerBucketForTransactionId(graphId, txId));
}

export async function tokenLedgerName(graphId: string, token: string): Promise<string> {
  return ledgerCoordinatorName(graphId, await ledgerBucketForRequestToken(graphId, token));
}

export function transactionIdForLedgerBucket(graphId: string, bucket: string): string {
  if (!isLedgerBucket(graphId, bucket)) throw new TypeError("invalid ledger bucket");
  return `poneglyph:tx:token:${bucket}:${crypto.randomUUID()}`;
}
export type TreeSnapshot = Readonly<{
  prefix: VirtualPrefix; readId: string; snapshotSeq: number; directoryEpoch: number; expiresAtMs: number;
}>;
export function parseTreeSnapshot(input: unknown, prefix: VirtualPrefix): TreeSnapshot {
  if (!isRecord(input) || input["prefix"] !== prefix ||
      typeof input["readId"] !== "string" || !/^[a-f0-9-]{36}$/.test(input["readId"])) {
    throw new Error("invalid subtree read lease identity");
  }
  const counter = (key: "snapshotSeq" | "directoryEpoch" | "expiresAtMs") => {
    const value = input[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid subtree read lease counter");
    return value;
  };
  return {prefix, readId: input["readId"], snapshotSeq: counter("snapshotSeq"), directoryEpoch: counter("directoryEpoch"), expiresAtMs: counter("expiresAtMs")};
}
