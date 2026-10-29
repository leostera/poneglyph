import { SHARD_SPLIT_TRIGGER_BYTES } from "./constants.js";
import { TREE_DEPTH } from "./forest.js";

/**
 * When a shard asks its owner tree to split it in two (after r2facts'
 * splittable objects): its average calls/s over `windowSeconds` stays above
 * `callsPerSecond`, or its database passes the size trigger.
 */
export type SplitPolicy = Readonly<{
  callsPerSecond: number;
  windowSeconds: number;
  /** Bytes of SQLite database past which a shard splits. */
  sizeBytes: number;
  /** No shard prefix longer than this: at most 2^(maxDepth - TREE_DEPTH) shards per owner. */
  maxDepth: number;
  /** How long a shard waits before asking again after asking once. */
  retryAfterMs: number;
}>;

/**
 * About half of what one shard serves (RFD0011: ~200-300 writes/s, each about
 * ten indexed inserts), sustained for 5 s, so a hot shard splits before it
 * saturates.
 */
export const DEFAULT_SPLIT_POLICY: SplitPolicy = {
  callsPerSecond: 100,
  windowSeconds: 5,
  sizeBytes: SHARD_SPLIT_TRIGGER_BYTES,
  maxDepth: TREE_DEPTH + 12,
  retryAfterMs: 30_000,
};

/** Calls per whole second, kept for a bounded window. */
export class CallRate {
  private readonly calls = new Map<number, number>();
  private readonly bornAt: number;

  constructor(now = Date.now()) { this.bornAt = now; }

  record(now = Date.now()): void {
    const second = Math.floor(now / 1000);
    this.calls.set(second, (this.calls.get(second) ?? 0) + 1);
    if (this.calls.size > 120) for (const key of this.calls.keys()) if (key < second - 60) this.calls.delete(key);
  }

  /** Average calls/s over the last `windowSeconds` full seconds, or 0 if this object is younger than that. */
  average(windowSeconds: number, now = Date.now()): number {
    if (now - this.bornAt < windowSeconds * 1000) return 0;
    const current = Math.floor(now / 1000);
    let total = 0;
    for (let second = current - windowSeconds; second < current; second++) total += this.calls.get(second) ?? 0;
    return total / windowSeconds;
  }
}

export type SplitReason = "call-rate" | "size";

/** Why a shard should split now, if it should. */
export function splitReason(policy: SplitPolicy, prefixLength: number, rate: CallRate, databaseBytes: number, now = Date.now()): SplitReason | undefined {
  if (prefixLength >= policy.maxDepth) return undefined;
  if (databaseBytes >= policy.sizeBytes) return "size";
  if (rate.average(policy.windowSeconds, now) > policy.callsPerSecond) return "call-rate";
  return undefined;
}
