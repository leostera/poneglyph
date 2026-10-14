import type { FactDraft } from "../domain/fact.js";
import {
  MAX_ACCOUNTED_BYTES_PER_DO,
  MINIMUM_UNCERTAINTY_HEADROOM_BYTES,
  MINIMUM_WAL_RESERVE_BYTES,
  SHARD_SPLIT_TRIGGER_BYTES,
} from "./constants.js";

export type MutationFootprint = Readonly<{
  factLogBytes: number;
  activeIndexBytes: number;
  projectionBytes: number;
  transactionStagingBytes: number;
}>;

export type AccountedStorage = Readonly<{
  databaseBytes: number;
  pending: MutationFootprint;
  walAndCheckpointReserveBytes: number;
  migrationReserveBytes: number;
  uncertaintyHeadroomBytes: number;
  projectedAccountedBytes: number;
  shouldSplit: boolean;
  canAdmit: boolean;
}>;

const encoder = new TextEncoder();

/** Conservative serialized-byte estimate; SQLite databaseSize remains the base measurement. */
export function estimateMutationFootprint(
  facts: readonly FactDraft[],
  existingProjectionBytesByEntity: ReadonlyMap<string, number> = new Map(),
): MutationFootprint {
  const factsByEntity = new Map<string, number>();
  let factLogBytes = 0;
  let activeIndexBytes = 0;
  let transactionStagingBytes = 0;

  for (const fact of facts) {
    const serialized = JSON.stringify(fact);
    const factBytes = encoder.encode(serialized).byteLength;
    factLogBytes += factBytes + 256;
    transactionStagingBytes += factBytes + 128;
    // Active tuples are duplicated into row payloads and several B-tree indexes.
    const scalarCount = fact.value.type === "list" ? Math.max(1, fact.value.value.length) : 1;
    activeIndexBytes += (factBytes + 128) * scalarCount * 4;
    factsByEntity.set(fact.entity, (factsByEntity.get(fact.entity) ?? 0) + factBytes);
  }

  let projectionBytes = 0;
  for (const [entity, entityFactBytes] of factsByEntity) {
    // Updating one field writes a new full projection; the old version remains for leased readers.
    const existingProjectionBytes = existingProjectionBytesByEntity.get(entity) ?? 0;
    projectionBytes += (existingProjectionBytes + entityFactBytes + encoder.encode(entity).byteLength + 512) * 2;
  }

  return Object.freeze({ factLogBytes, activeIndexBytes, projectionBytes, transactionStagingBytes });
}

export function accountStorage(
  databaseBytes: number,
  pending: MutationFootprint,
  migrationReserveBytes = 0,
): AccountedStorage {
  if (!isByteCount(databaseBytes) || !isByteCount(migrationReserveBytes)) {
    throw new RangeError("storage byte counts must be non-negative safe integers");
  }
  for (const bytes of Object.values(pending)) {
    if (!isByteCount(bytes)) throw new RangeError("pending byte estimates must be non-negative safe integers");
  }

  const pendingGrowthBytes = pending.factLogBytes + pending.activeIndexBytes + pending.projectionBytes + pending.transactionStagingBytes;
  const projectedDatabaseBytes = databaseBytes + pendingGrowthBytes;
  const walAndCheckpointReserveBytes = Math.max(
    MINIMUM_WAL_RESERVE_BYTES,
    Math.ceil(projectedDatabaseBytes * 0.1),
  );
  const uncertaintyHeadroomBytes = MINIMUM_UNCERTAINTY_HEADROOM_BYTES;
  const projectedAccountedBytes = projectedDatabaseBytes + walAndCheckpointReserveBytes + migrationReserveBytes + uncertaintyHeadroomBytes;

  return Object.freeze({
    databaseBytes,
    pending,
    walAndCheckpointReserveBytes,
    migrationReserveBytes,
    uncertaintyHeadroomBytes,
    projectedAccountedBytes,
    shouldSplit: projectedDatabaseBytes >= SHARD_SPLIT_TRIGGER_BYTES,
    canAdmit: projectedAccountedBytes <= MAX_ACCOUNTED_BYTES_PER_DO,
  });
}

function isByteCount(input: number): boolean {
  return Number.isSafeInteger(input) && input >= 0;
}
