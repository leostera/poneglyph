import { SHARD_SPLIT_TRIGGER_BYTES } from "./constants.js";
import { accountStorage } from "./capacity.js";
import { bitAt, ROOT_PREFIX, virtualKeyForEntity, type VirtualKey, type VirtualPrefix } from "./keys.js";

const SYNTHETIC_GRAPH_ID = "capacity-simulation";
const EMPTY_MUTATION = { factLogBytes: 0, activeIndexBytes: 0, projectionBytes: 0, transactionStagingBytes: 0 } as const;

type WeightedKey = Readonly<{ entity: string; key: VirtualKey; bytes: number }>;
type LogicalShard = Readonly<{ prefix: VirtualPrefix; entities: number; bytes: number }>;

export type CapacitySimulationResult = Readonly<{
  logicalBytes: number;
  syntheticEntities: number;
  physicalRowsWritten: 0;
  leaves: number;
  routers: number;
  maxDepth: number;
  largestLeafBytes: number;
  smallestLeafBytes: number;
  maxAccountedBytes: number;
  cloudflareHardLimitBytes: number;
  applicationAccountedLimitBytes: number;
}>;

/** Exercises the same 256-bit prefix split and byte-budget policy without writing synthetic payloads. */
export async function simulateCapacityEnvelope(
  logicalBytes = 1_000_000_000_000,
  syntheticEntities = 10_000,
): Promise<CapacitySimulationResult> {
  if (!Number.isSafeInteger(logicalBytes) || logicalBytes <= 0) throw new RangeError("logicalBytes must be positive");
  if (!Number.isSafeInteger(syntheticEntities) || syntheticEntities <= 0) throw new RangeError("syntheticEntities must be positive");

  const baseWeight = Math.floor(logicalBytes / syntheticEntities);
  const remainder = logicalBytes % syntheticEntities;
  const weightedKeys = await Promise.all(Array.from({ length: syntheticEntities }, async (_, index) => {
    const entity = `wiki:capacity:synthetic-${index.toString().padStart(8, "0")}`;
    return {
      entity,
      key: await virtualKeyForEntity(SYNTHETIC_GRAPH_ID, entity),
      bytes: baseWeight + (index < remainder ? 1 : 0),
    } satisfies WeightedKey;
  }));

  const leaves = splitUntilSafe(ROOT_PREFIX, weightedKeys);
  const largestLeafBytes = Math.max(...leaves.map((leaf) => leaf.bytes));
  const smallestLeafBytes = Math.min(...leaves.map((leaf) => leaf.bytes));
  let maxAccountedBytes = 0;
  for (const leaf of leaves) {
    const accounting = accountStorage(leaf.bytes, EMPTY_MUTATION);
    if (!accounting.canAdmit || leaf.bytes >= SHARD_SPLIT_TRIGGER_BYTES) {
      throw new Error(`synthetic shard ${leaf.prefix} violates the capacity policy`);
    }
    maxAccountedBytes = Math.max(maxAccountedBytes, accounting.projectedAccountedBytes);
  }

  const assignedBytes = leaves.reduce((total, leaf) => total + leaf.bytes, 0);
  if (assignedBytes !== logicalBytes) throw new Error("synthetic sharding lost logical bytes");
  return Object.freeze({
    logicalBytes,
    syntheticEntities,
    physicalRowsWritten: 0,
    leaves: leaves.length,
    routers: Math.max(0, leaves.length - 1),
    maxDepth: Math.max(...leaves.map((leaf) => leaf.prefix.length)),
    largestLeafBytes,
    smallestLeafBytes,
    maxAccountedBytes,
    cloudflareHardLimitBytes: 10_000_000_000,
    applicationAccountedLimitBytes: 8_000_000_000,
  });
}

function splitUntilSafe(prefix: VirtualPrefix, entities: readonly WeightedKey[]): LogicalShard[] {
  const bytes = entities.reduce((total, entity) => total + entity.bytes, 0);
  if (bytes < SHARD_SPLIT_TRIGGER_BYTES) return [{ prefix, entities: entities.length, bytes }];
  if (prefix.length >= 256 || entities.every((entity) => entity.key === entities[0]?.key)) {
    throw new Error(`logical range ${prefix} cannot be divided below the split threshold`);
  }

  const nextBit = prefix.length;
  const left: WeightedKey[] = [];
  const right: WeightedKey[] = [];
  for (const entity of entities) (bitAt(entity.key, nextBit) === "0" ? left : right).push(entity);
  const leftPrefix = `${prefix}0` as VirtualPrefix;
  const rightPrefix = `${prefix}1` as VirtualPrefix;
  return [
    ...splitUntilSafe(leftPrefix, left),
    ...splitUntilSafe(rightPrefix, right),
  ];
}
