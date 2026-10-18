import {parseGraphId, type GraphId} from "../domain/graph-id.js";
import {parseTransactionId, type TransactionId} from "../domain/identifiers.js";
import {isRecord, parsed, rejected, type ParseResult} from "../domain/result.js";
import {parseVirtualPrefix, type VirtualPrefix} from "./keys.js";

export type DecisionControl = Readonly<{
  graphId: GraphId;
  shardPrefix: VirtualPrefix;
  shardGeneration: number;
  directoryEpoch: number;
  txId: TransactionId;
  payloadHash: string;
  commitSeq: number;
  statementTimeMs: number;
  identityTimeMs: number;
}>;

// Shape checks only. The shard must still verify its identity, durable phase
// and exact decision context before performing any storage transition.
export function parseDecisionControl(input: unknown): ParseResult<DecisionControl> {
  if (!isRecord(input)) return rejected("decision", "expected a commit object");
  const statementTimeMs = input["statementTimeMs"];
  const identityTimeMs = input["identityTimeMs"];
  // Preserve timestamp-error precedence, including when other fields are bad.
  if (!isNonNegativeInteger(statementTimeMs) || !isNonNegativeInteger(identityTimeMs)) {
    return rejected("decision", "invalid decision timestamps");
  }
  const graphId = parseGraphId(input["graphId"]);
  const shardPrefix = parseVirtualPrefix(input["shardPrefix"]);
  const shardGeneration = input["shardGeneration"];
  const directoryEpoch = input["directoryEpoch"];
  const txId = parseTransactionId(input["txId"]);
  const payloadHash = input["payloadHash"];
  const commitSeq = input["commitSeq"];
  if (!graphId.ok || !shardPrefix.ok || !isNonNegativeInteger(shardGeneration) || !isNonNegativeInteger(directoryEpoch) || !txId.ok ||
      !isNonNegativeInteger(commitSeq) || typeof payloadHash !== "string" || !/^[a-f0-9]{64}$/.test(payloadHash)) {
    return rejected("decision", "invalid commit request");
  }
  return parsed(Object.freeze({
    graphId: graphId.value,
    shardPrefix: shardPrefix.value,
    shardGeneration,
    directoryEpoch,
    txId: txId.value,
    payloadHash,
    commitSeq,
    statementTimeMs,
    identityTimeMs,
  }));
}

// This exact JSON field order is persisted in decision_context_json. Keep it
// independent of input key order and ignore non-context fields (such as facts).
export function decisionContext(control: DecisionControl): string {
  return JSON.stringify({
    graphId: control.graphId,
    shardPrefix: control.shardPrefix,
    shardGeneration: control.shardGeneration,
    directoryEpoch: control.directoryEpoch,
    txId: control.txId,
    payloadHash: control.payloadHash,
    commitSeq: control.commitSeq,
    statementTimeMs: control.statementTimeMs,
    identityTimeMs: control.identityTimeMs,
  });
}

function isNonNegativeInteger(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0;
}
