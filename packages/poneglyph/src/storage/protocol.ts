import { parseFactDraft, type FactDraft } from "../domain/fact.js";
import { parseGraphId, type GraphId } from "../domain/graph-id.js";
import { parseTransactionId, parseUri, type TransactionId } from "../domain/identifiers.js";
import { isRecord, parsed, rejected, type ParseResult } from "../domain/result.js";
import { parseDatalogValue, type DatalogValue } from "../datalog/value.js";
import { MAX_QUERY_VALUE_SET_SIZE } from "./constants.js";
import { parseVirtualKey, parseVirtualPrefix, type VirtualKey, type VirtualPrefix } from "./keys.js";

export type IndexedFact = Readonly<{ index: number; fact: FactDraft; virtualKey: VirtualKey }>;
export type NonEmptyArray<T> = readonly [T, ...T[]];

export type ParticipantBatch = Readonly<{
  graphId: GraphId;
  shardPrefix: VirtualPrefix;
  shardGeneration: number;
  directoryEpoch: number;
  txId: TransactionId;
  payloadHash: string;
  statementTimeMs: number;
  identityTimeMs: number;
  commitSeq: number;
  facts: NonEmptyArray<IndexedFact>;
}>;

type ScanFilter =
  | Readonly<{kind: "all"}>
  | Readonly<{kind: "entity"; entity: DatalogValue}>
  | Readonly<{kind: "value"; value: DatalogValue; joinField?: string}>
  | Readonly<{kind: "entity-value"; entity: DatalogValue; value: DatalogValue; joinField?: string}>
  | Readonly<{kind: "values"; values: NonEmptyArray<DatalogValue>}>;

type ScanIdentity = Readonly<{
  graphId: GraphId;
  shardPrefix: VirtualPrefix;
  shardGeneration: number;
  directoryEpoch: number;
  field: string;
  snapshotSeq: number;
  leaseExpiresAtMs: number;
}>;

export type ScanRequest = ScanIdentity & ScanFilter;

export function parseParticipantBatch(input: unknown): ParseResult<ParticipantBatch> {
  if (!isRecord(input)) return rejected("participant", "expected a prepare request object");
  const graphId = parseGraphId(input["graphId"], "participant.graphId");
  if (!graphId.ok) return graphId;
  const shardPrefix = parseVirtualPrefix(input["shardPrefix"]);
  if (!shardPrefix.ok) return shardPrefix;
  const shardGeneration = readNonNegativeInteger(input["shardGeneration"]);
  const directoryEpoch = readNonNegativeInteger(input["directoryEpoch"]);
  if (shardGeneration === undefined || directoryEpoch === undefined) return rejected("participant", "invalid shard generation or directory epoch");
  const txId = parseTransactionId(input["txId"], "participant.txId");
  if (!txId.ok) return txId;
  const payloadHash = input["payloadHash"];
  if (typeof payloadHash !== "string" || !/^[a-f0-9]{64}$/.test(payloadHash)) {
    return rejected("participant.payloadHash", "expected a SHA-256 hex digest");
  }
  const statementTimeMs = input["statementTimeMs"];
  if (!Number.isSafeInteger(statementTimeMs) || typeof statementTimeMs !== "number" || statementTimeMs < 0) {
    return rejected("participant.statementTimeMs", "expected a non-negative safe integer timestamp");
  }
  const identityTimeMs = readNonNegativeInteger(input["identityTimeMs"]);
  if (identityTimeMs === undefined) return rejected("participant.identityTimeMs", "expected an identity-window timestamp");
  const commitSeq = input["commitSeq"];
  if (!Number.isSafeInteger(commitSeq) || typeof commitSeq !== "number" || commitSeq < 0) {
    return rejected("participant.commitSeq", "expected a non-negative safe integer sequence");
  }
  if (!Array.isArray(input["facts"]) || input["facts"].length === 0) {
    return rejected("participant.facts", "expected a non-empty fact list");
  }

  const facts: IndexedFact[] = [];
  for (const [offset, item] of input["facts"].entries()) {
    if (!isRecord(item)) return rejected(`participant.facts[${offset}]`, "expected an indexed fact");
    const index = item["index"];
    // Strictly increasing indices already guarantee uniqueness. Equal fact
    // contents at different indices must remain separate journal events.
    const previous = facts[facts.length - 1];
    if (!Number.isSafeInteger(index) || typeof index !== "number" || index < 0 || (previous !== undefined && index <= previous.index)) {
      return rejected(`participant.facts[${offset}].index`, "expected a unique non-negative fact index");
    }
    const fact = parseFactDraft(item["fact"], `participant.facts[${offset}].fact`);
    if (!fact.ok) return fact;
    const virtualKey = parseVirtualKey(item["virtualKey"]);
    if (!virtualKey.ok) return virtualKey;
    facts.push(Object.freeze({ index, fact: fact.value, virtualKey: virtualKey.value }));
  }

  return parsed(Object.freeze({
    graphId: graphId.value,
    shardPrefix: shardPrefix.value,
    shardGeneration,
    directoryEpoch,
    txId: txId.value,
    payloadHash,
    statementTimeMs,
    identityTimeMs,
    commitSeq,
    facts: Object.freeze(facts) as NonEmptyArray<IndexedFact>,
  }));
}

export function parseScanRequest(input: unknown): ParseResult<ScanRequest> {
  if (!isRecord(input)) return rejected("scan", "expected a scan request object");
  const graphId = parseGraphId(input["graphId"], "scan.graphId");
  if (!graphId.ok) return graphId;
  const shardPrefix = parseVirtualPrefix(input["shardPrefix"]);
  if (!shardPrefix.ok) return shardPrefix;
  const shardGeneration = readNonNegativeInteger(input["shardGeneration"]);
  const directoryEpoch = readNonNegativeInteger(input["directoryEpoch"]);
  if (shardGeneration === undefined || directoryEpoch === undefined) return rejected("scan", "invalid shard generation or directory epoch");
  const field = parseUri(input["field"], "scan.field");
  if (!field.ok) return field;
  const snapshotSeq = input["snapshotSeq"];
  if (!Number.isSafeInteger(snapshotSeq) || typeof snapshotSeq !== "number" || snapshotSeq < 0) {
    return rejected("scan.snapshotSeq", "expected a non-negative safe integer");
  }
  const leaseExpiresAtMs = input["leaseExpiresAtMs"];
  if (!Number.isSafeInteger(leaseExpiresAtMs) || typeof leaseExpiresAtMs !== "number") {
    return rejected("scan.leaseExpiresAtMs", "expected a safe integer timestamp");
  }

  const filter = parseScanFilter(input);
  if (!filter.ok) return filter;
  return parsed(Object.freeze({
    graphId: graphId.value,
    shardPrefix: shardPrefix.value,
    shardGeneration,
    directoryEpoch,
    field: field.value,
    snapshotSeq,
    leaseExpiresAtMs,
    ...filter.value,
  }));
}

function parseScanFilter(input: Record<string, unknown>): ParseResult<ScanFilter> {
  let entity: DatalogValue | undefined;
  if (input["entity"] !== undefined) {
    const parsedEntity = parseDatalogValue(input["entity"], "scan.entity");
    if (!parsedEntity.ok) return parsedEntity;
    entity = parsedEntity.value;
  }

  let value: DatalogValue | undefined;
  if (input["value"] !== undefined) {
    const parsedValue = parseDatalogValue(input["value"], "scan.value");
    if (!parsedValue.ok) return parsedValue;
    value = parsedValue.value;
  }

  let values: NonEmptyArray<DatalogValue> | undefined;
  if (input["values"] !== undefined) {
    const rawValues = input["values"];
    if (!Array.isArray(rawValues) || rawValues.length === 0 || rawValues.length > MAX_QUERY_VALUE_SET_SIZE) {
      return rejected("scan.values", `expected between 1 and ${MAX_QUERY_VALUE_SET_SIZE} values`);
    }
    if (value !== undefined || entity !== undefined) {
      return rejected("scan.values", "value-set scans cannot include entity or single-value filters");
    }
    const parsedValues: DatalogValue[] = [];
    const seen = new Set<string>();
    for (const [index, inputValue] of rawValues.entries()) {
      const parsedValue = parseDatalogValue(inputValue, `scan.values[${index}]`);
      if (!parsedValue.ok) return parsedValue;
      const key = JSON.stringify([parsedValue.value.type, parsedValue.value.value]);
      if (seen.has(key)) return rejected(`scan.values[${index}]`, "expected distinct values");
      seen.add(key);
      parsedValues.push(parsedValue.value);
    }
    values = Object.freeze(parsedValues) as NonEmptyArray<DatalogValue>;
  }

  let joinField: string | undefined;
  if (input["joinField"] !== undefined) {
    const parsedJoinField = parseUri(input["joinField"], "scan.joinField");
    if (!parsedJoinField.ok) return parsedJoinField;
    joinField = parsedJoinField.value;
  }

  if (values !== undefined) {
    if (joinField !== undefined) return rejected("scan.joinField", "entity join requires a bound input value");
    return parsed(Object.freeze({kind: "values", values}));
  }
  if (entity !== undefined && value !== undefined) {
    return parsed(Object.freeze(joinField === undefined
      ? {kind: "entity-value", entity, value}
      : {kind: "entity-value", entity, value, joinField}));
  }
  if (entity !== undefined) {
    if (joinField !== undefined) return rejected("scan.joinField", "entity join requires a bound input value");
    return parsed(Object.freeze({kind: "entity", entity}));
  }
  if (value !== undefined) {
    return parsed(Object.freeze(joinField === undefined
      ? {kind: "value", value}
      : {kind: "value", value, joinField}));
  }
  if (joinField !== undefined) return rejected("scan.joinField", "entity join requires a bound input value");
  return parsed(Object.freeze({kind: "all"}));
}

export function factAsJson(fact: FactDraft): FactDraft {
  return {
    source: fact.source,
    entity: fact.entity,
    field: fact.field,
    value: fact.value,
    retraction: fact.retraction,
  };
}

function readNonNegativeInteger(input: unknown): number | undefined {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : undefined;
}
