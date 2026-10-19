import assert from "node:assert/strict";
import {test} from "vitest";
import {parseAuthorityActors, parseCoordinatorAuthority, parseShardAuthority} from "./authority-evidence.js";
import {parseAuthorityIdentities} from "./worker/authority-controls.js";
test("authority control identities become bounded trusted URI lists before actor lookup", () => {
  assert.deepEqual(parseAuthorityIdentities(["tx:one", "tx:one"]), ["tx:one", "tx:one"]);
  assert.ok(Object.isFrozen(parseAuthorityIdentities([])));
  for (const input of [null, {}, ["bare"], [1], ["tx:" + "x".repeat(1024)], Array.from({length: 129}, () => "tx:one")]) assert.throws(() => parseAuthorityIdentities(input));
});
const healthy = {
  state: {writer_tx_id: null, topology_op_id: null},
  counts: {pendingGraph: 0, pendingCandidate: 0, pendingReservations: 0, locks: 0, pendingTopology: 0, activeLeases: 0, invalidPublications: 0},
  rows: [{cursor: 1, tx_id: "tx:one", phase: "complete", payload_hash: "a".repeat(64), commit_seq: 1, graph_id: "test"}],
};
test("mandatory quiescent obligation counts cannot omit, coerce or hide pending work", () => {
  assert.equal(parseCoordinatorAuthority(healthy, 0)[0]?.txId, "tx:one");
  for (const name of Object.keys(healthy.counts)) {
    for (const value of [1, -1, "0", null, 0.5]) assert.throws(() => parseCoordinatorAuthority({...healthy, counts: {...healthy.counts, [name]: value}}, 0));
    const missing: Record<string, number> = {...healthy.counts}; delete missing[name];
    assert.throws(() => parseCoordinatorAuthority({...healthy, counts: missing}, 0));
  }
  for (const field of ["writer_tx_id", "topology_op_id"]) assert.throws(() => parseCoordinatorAuthority({...healthy, state: {...healthy.state, [field]: "pending"}}, 0));
});
test("terminal decisions preserve typed identity, graph, sequence and strict bounded cursor", () => {
  for (const patch of [{phase: "preparing"}, {phase: "committing"}, {commit_seq: 0}, {commit_seq: "1"}, {tx_id: "bare"}, {payload_hash: "short"}, {graph_id: undefined}, {cursor: 0}, {cursor: 0.5}]) assert.throws(() => parseCoordinatorAuthority({...healthy, rows: [{...healthy.rows[0], ...patch}]}, 0));
  assert.throws(() => parseCoordinatorAuthority(healthy, 1));
  assert.throws(() => parseCoordinatorAuthority({...healthy, rows: [healthy.rows[0], healthy.rows[0]]}, 0));
  assert.throws(() => parseCoordinatorAuthority({...healthy, rows: Array.from({length: 129}, (_, i) => ({...healthy.rows[0], cursor: i + 1}))}, 0));
  assert.equal(parseCoordinatorAuthority({...healthy, rows: [{...healthy.rows[0], phase: "aborted", commit_seq: 0}]}, 0)[0]?.phase, "aborted");
});
test("participant preparation and release/publication obligations fail closed", () => {
  const valid = {prepared: 0, unpublished: 0, cachedProofPending: 0, rows: [], identity: null};
  parseShardAuthority(valid, "test", "0000", 0);
  // A pending cached pruning proof is not actual owner release/publication;
  // the separate exact-witness checker must establish those obligations.
  parseShardAuthority({...valid, cachedProofPending: 1}, "test", "0000", 0);
  for (const patch of [{prepared: 1}, {unpublished: 1}, {prepared: "0"}, {cachedProofPending: "0"}, {prepared: -1}, {identity: {graph_id: "wrong", prefix: "0000"}}]) assert.throws(() => parseShardAuthority({...valid, ...patch}, "test", "0000", 0));
  assert.throws(() => parseShardAuthority({}, "test", "0000", 0));
});
test("authority roles and identities are parsed before state inspection", () => {
  assert.deepEqual(parseAuthorityActors([{name: "graph:test", role: "graph"}]), [{name: "graph:test", role: "graph"}]);
  for (const input of [null, [], [{name: "", role: "graph"}], [{name: "graph:test", role: "wrong"}], [{name: "graph:test", role: "graph"}, {name: "graph:test", role: "owner"}]]) assert.throws(() => parseAuthorityActors(input));
});
