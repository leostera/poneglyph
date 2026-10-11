import { parseFactDraft, type FactDraft } from "../domain/fact.js";
import { parseGraphId, type GraphId } from "../domain/graph-id.js";
import { parseTransactionId, parseUri, type TransactionId } from "../domain/identifiers.js";
import { isRecord, parsed, rejected, type ParseResult } from "../domain/result.js";
import { parseDatalogValue, type DatalogValue } from "../datalog/value.js";
import { SHARD_COUNT } from "./constants.js";

export type IndexedFact = Readonly<{ index: number; fact: FactDraft }>;
export type NonEmptyArray<T> = readonly [T, ...T[]];

export type ParticipantBatch = Readonly<{
  graphId: GraphId;
  shardIndex: number;
  txId: TransactionId;
  payloadHash: string;
  statementTimeMs: number;
  commitSeq: number;
  facts: NonEmptyArray<IndexedFact>;
}>;

export type ScanRequest = Readonly<{
  graphId: GraphId;
  shardIndex: number;
  field: string;
  entity?: DatalogValue;
  value?: DatalogValue;
  snapshotSeq: number;
  leaseExpiresAtMs: number;
}>;

export function parseParticipantBatch(input: unknown): ParseResult<ParticipantBatch> {
  if (!isRecord(input)) return rejected("participant", "expected a prepare request object");
  const graphId = parseGraphId(input["graphId"], "participant.graphId");
  if (!graphId.ok) return graphId;
  const shardIndex = parseShardIndex(input["shardIndex"], "participant.shardIndex");
  if (!shardIndex.ok) return shardIndex;
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
  const commitSeq = input["commitSeq"];
  if (!Number.isSafeInteger(commitSeq) || typeof commitSeq !== "number" || commitSeq < 1) {
    return rejected("participant.commitSeq", "expected a positive safe integer sequence");
  }
  if (!Array.isArray(input["facts"]) || input["facts"].length === 0) {
    return rejected("participant.facts", "expected a non-empty fact list");
  }

  const facts: IndexedFact[] = [];
  const indices = new Set<number>();
  for (const [offset, item] of input["facts"].entries()) {
    if (!isRecord(item)) return rejected(`participant.facts[${offset}]`, "expected an indexed fact");
    const index = item["index"];
    if (!Number.isSafeInteger(index) || typeof index !== "number" || index < 0 || indices.has(index)) {
      return rejected(`participant.facts[${offset}].index`, "expected a unique non-negative fact index");
    }
    const fact = parseFactDraft(item["fact"], `participant.facts[${offset}].fact`);
    if (!fact.ok) return fact;
    indices.add(index);
    facts.push(Object.freeze({ index, fact: fact.value }));
  }

  return parsed(Object.freeze({
    graphId: graphId.value,
    shardIndex: shardIndex.value,
    txId: txId.value,
    payloadHash,
    statementTimeMs,
    commitSeq,
    facts: Object.freeze(facts) as NonEmptyArray<IndexedFact>,
  }));
}

export function parseScanRequest(input: unknown): ParseResult<ScanRequest> {
  if (!isRecord(input)) return rejected("scan", "expected a scan request object");
  const graphId = parseGraphId(input["graphId"], "scan.graphId");
  if (!graphId.ok) return graphId;
  const shardIndex = parseShardIndex(input["shardIndex"], "scan.shardIndex");
  if (!shardIndex.ok) return shardIndex;
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
    shardIndex: number;
    field: string;
    snapshotSeq: number;
    leaseExpiresAtMs: number;
    entity?: DatalogValue;
    value?: DatalogValue;
  } = {
    graphId: graphId.value,
    shardIndex: shardIndex.value,
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

  return parsed(Object.freeze(request));
}

function parseShardIndex(input: unknown, path: string): ParseResult<number> {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 0 || input >= SHARD_COUNT) {
    return rejected(path, `expected a shard index between 0 and ${SHARD_COUNT - 1}`);
  }
  return parsed(input);
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
