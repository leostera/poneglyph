import { parseVirtualPrefix, type VirtualPrefix } from "./keys.js";

export const MIGRATION_TABLES = {
  fact_log: ["fact_id", "tx_id", "tx_index", "commit_seq", "source", "entity", "entity_hash", "field", "value_json", "retraction", "stated_at"],
  active_facts: ["source", "entity", "entity_hash", "field", "value_json", "fact_id", "tx_id", "stated_at", "valid_from_seq", "valid_to_seq"],
  active_values: ["fact_id", "value_index", "source", "entity", "entity_hash", "field", "datalog_type", "datalog_value", "value_key", "value_json", "tx_id", "stated_at", "valid_from_seq", "valid_to_seq"],
  entity_versions: ["entity", "entity_hash", "fields_json", "last_tx_id", "valid_from_seq", "valid_to_seq"],
} as const;

export type MigrationTable = keyof typeof MIGRATION_TABLES;
export type MigrationRow = Readonly<Record<string, null | number | string>>;

export function parseMigrationTable(input: unknown): MigrationTable | undefined {
  return typeof input === "string" && Object.hasOwn(MIGRATION_TABLES, input)
    ? input as MigrationTable
    : undefined;
}

export function virtualKeyRange(prefix: VirtualPrefix): readonly [string, string] {
  const parsed = parseVirtualPrefix(prefix);
  if (!parsed.ok) throw new TypeError("invalid virtual prefix");
  const depth = BigInt(prefix.length);
  const low = prefix.length === 0 ? 0n : BigInt(`0b${prefix}`);
  const lower = low << (256n - depth);
  const upper = lower + ((1n << (256n - depth)) - 1n);
  return [lower.toString(16).padStart(64, "0"), upper.toString(16).padStart(64, "0")];
}

export function migrationRowBytes(rows: readonly MigrationRow[]): number {
  return new TextEncoder().encode(JSON.stringify(rows)).byteLength;
}
