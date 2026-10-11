import { ROUTING_VERSION, SHARD_COUNT } from "./constants.js";

const FNV_OFFSET_BASIS = 14_695_981_039_346_656_037n;
const FNV_PRIME = 1_099_511_628_211n;

export function shardIndexForEntity(entity: string, shardCount = SHARD_COUNT): number {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new RangeError("shardCount must be a positive safe integer");
  }

  let hash = FNV_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(entity)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * FNV_PRIME);
  }
  return Number(hash % BigInt(shardCount));
}

export function shardObjectName(graphId: string, shardIndex: number): string {
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= SHARD_COUNT) {
    throw new RangeError(`shard index must be between 0 and ${SHARD_COUNT - 1}`);
  }
  return `graph:${graphId}:leaf:v${ROUTING_VERSION}:${shardIndex}`;
}

export function coordinatorObjectName(graphId: string): string {
  return `graph:${graphId}:coordinator:v${ROUTING_VERSION}`;
}
