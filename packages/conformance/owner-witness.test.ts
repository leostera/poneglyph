import assert from "node:assert/strict";
import {test} from "node:test";
import {parseParticipantWitness, verifyOwnerWitness} from "./owner-witness.js";
const participant = {cursor: 1, tx_id: "tx:one", payload_hash: "a".repeat(64), status: "committed", decision_kind: "atomic", created_at_ms: 100,
  decision_context_json: null, atomic_commit_seq: 7, atomic_statement_ms: 101, atomic_generation: 0, atomic_directory_epoch: 2, owner_released: 0};
const owner = {rows: [{tx_id: "tx:one", payload_hash: "a".repeat(64), ticket_seq: 7, directory_epoch: 2, phase: "complete", commit_seq: 7, created_at_ms: 100}], state: {visible_seq: 7}, locks: 0};
test("cached and uncached outcomes both require exact durable owner release/publication", () => {
  const pending = parseParticipantWitness(participant, "test", "010100", 4);
  const cached = parseParticipantWitness({...participant, owner_released: 1}, "test", "010100", 4);
  assert.deepEqual(pending, cached); verifyOwnerWitness(owner, pending); verifyOwnerWitness(owner, cached);
  for (const patch of [{tx_id: "tx:other"}, {payload_hash: "b".repeat(64)}, {ticket_seq: 8}, {directory_epoch: 3}, {phase: "preparing"}, {phase: "aborted"}, {commit_seq: 8}, {created_at_ms: 99}]) {
    const corrupt = {...owner, rows: [{...owner.rows[0], ...patch}], state: {visible_seq: 1000}};
    assert.throws(() => verifyOwnerWitness(corrupt, pending)); assert.throws(() => verifyOwnerWitness(corrupt, cached));
  }
  for (const corrupt of [{...owner, locks: 1}, {...owner, rows: []}, {...owner, rows: [owner.rows[0], owner.rows[0]]}, {...owner, state: {visible_seq: 6}}, {...owner, state: {visible_seq: "7"}}]) assert.throws(() => verifyOwnerWitness(corrupt, pending));
});
test("distributed identity context remains exact across descendants of the same owner", () => {
  const context = {graphId: "test", shardPrefix: "0101", shardGeneration: 0, directoryEpoch: 2, txId: "tx:one", payloadHash: "a".repeat(64), commitSeq: 7, statementTimeMs: 101, identityTimeMs: 100};
  const raw = {...participant, decision_kind: "distributed", decision_context_json: JSON.stringify(context)};
  const expected = parseParticipantWitness(raw, "test", "010100", 4); verifyOwnerWitness(owner, expected);
  for (const patch of [{graphId: "other"}, {shardPrefix: "1101"}, {shardGeneration: "0"}, {directoryEpoch: -1}, {txId: "tx:other"}, {payloadHash: "b".repeat(64)}, {identityTimeMs: 99}, {commitSeq: 0}, {statementTimeMs: null}]) assert.throws(() => parseParticipantWitness({...raw, decision_context_json: JSON.stringify({...context, ...patch})}, "test", "010100", 4));
});
test("aborted owner witness must be exact and lock-free, not fabricated from visibility", () => {
  const expected = parseParticipantWitness({...participant, status: "cancelled"}, "test", "010100", 4);
  verifyOwnerWitness({...owner, rows: [{...owner.rows[0], phase: "aborted", commit_seq: 0}]}, expected);
  assert.throws(() => verifyOwnerWitness(owner, expected));
  for (const patch of [{owner_released: "1"}, {status: "prepared"}, {decision_kind: "unknown"}, {atomic_directory_epoch: null}, {atomic_generation: null}, {created_at_ms: "100"}, {payload_hash: "short"}]) assert.throws(() => parseParticipantWitness({...participant, ...patch}, "test", "010100", 4));
});
