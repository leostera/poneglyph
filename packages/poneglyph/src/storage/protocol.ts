import { parseFactDraft, type FactDraft } from "../domain/fact.js";
import { parseGraphId, type GraphId } from "../domain/graph-id.js";
import { parseTransactionId, parseUri, type TransactionId } from "../domain/identifiers.js";
import { isRecord, parsed, rejected, type ParseResult } from "../domain/result.js";
import { parseDatalogValue, type DatalogValue } from "../datalog/value.js";
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

export type ScanRequest = Readonly<{
  graphId: GraphId;
  shardPrefix: VirtualPrefix;
  shardGeneration: number;
  directoryEpoch: number;
  field: string;
  joinField?: string;
  entity?: DatalogValue;
  value?: DatalogValue;
  snapshotSeq: number;
  leaseExpiresAtMs: number;
}>;

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
  const indices = new Set<number>();
  for (const [offset, item] of input["facts"].entries()) {
    if (!isRecord(item)) return rejected(`participant.facts[${offset}]`, "expected an indexed fact");
    const index = item["index"];
    if (!Number.isSafeInteger(index) || typeof index !== "number" || index < 0 || indices.has(index) || (facts.length > 0 && index <= facts[facts.length - 1]!.index)) {
      return rejected(`participant.facts[${offset}].index`, "expected a unique non-negative fact index");
    }
    const fact = parseFactDraft(item["fact"], `participant.facts[${offset}].fact`);
    if (!fact.ok) return fact;
    const virtualKey = parseVirtualKey(item["virtualKey"]);
    if (!virtualKey.ok) return virtualKey;
    indices.add(index);
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

  const request: {
    graphId: GraphId;
    shardPrefix: VirtualPrefix;
    shardGeneration: number;
    directoryEpoch: number;
    field: string;
    joinField?: string;
    snapshotSeq: number;
    leaseExpiresAtMs: number;
    entity?: DatalogValue;
    value?: DatalogValue;
  } = {
    graphId: graphId.value,
    shardPrefix: shardPrefix.value,
    shardGeneration,
    directoryEpoch,
    field: field.value,
    snapshotSeq,
    leaseExpiresAtMs,
  };
  if (input["entity"] !== undefined) {
    const entity = parseDatalogValue(input["entity"], "scan.entity");
    if (!entity.ok) return entity;
    request.entity = entity.value;
  }
  if (input["value"] !== undefined) {
    const value = parseDatalogValue(input["value"], "scan.value");
    if (!value.ok) return value;
    request.value = value.value;
  }

  if (input["joinField"] !== undefined) {
    const joinField = parseUri(input["joinField"], "scan.joinField");
    if (!joinField.ok) return joinField;
    if (request.value === undefined) return rejected("scan.joinField", "entity join requires a bound input value");
    request.joinField = joinField.value;
  }
  return parsed(Object.freeze(request));
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
