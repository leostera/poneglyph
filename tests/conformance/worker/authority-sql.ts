export type AuthorityLayout = Readonly<{
  candidate: boolean;
  entityLocks: boolean;
  publication: "none" | "atomic_published" | "owner_released";
}>;
export type AuthorityRole = "graph" | "owner" | "ledger";
// These are bounded, read-only observations. No phase is advanced, no expired
// row is deleted and no missing input is admitted by an audit.
export function coordinatorAuthority(storage: DurableObjectStorage, layout: AuthorityLayout, role: AuthorityRole, after: number) {
  const state = storage.sql.exec<{writer_tx_id: string | null; topology_op_id: string | null}>("SELECT writer_tx_id, topology_op_id FROM graph_state WHERE singleton = 1").one();
  const count = (sql: string) => storage.sql.exec<{count: number}>(sql).one().count;
  const pendingGraph = count("SELECT COUNT(*) AS count FROM graph_transactions WHERE phase NOT IN ('complete', 'aborted')");
  const pendingCandidate = layout.candidate ? count("SELECT COUNT(*) AS count FROM candidate_transactions WHERE phase NOT IN ('complete', 'aborted')") : 0;
  const pendingReservations = layout.candidate ? count("SELECT COUNT(*) AS count FROM tree_reservations WHERE phase NOT IN ('complete', 'aborted')") : 0;
  const locks = layout.entityLocks ? count("SELECT COUNT(*) AS count FROM entity_write_locks") : 0;
  const pendingTopology = count("SELECT COUNT(*) AS count FROM graph_splits WHERE phase NOT IN ('cutover', 'retired')");
  const activeLeases = storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM graph_read_leases WHERE expires_at_ms > ?", Date.now()).one().count;
  const invalidPublications = layout.candidate ? count("SELECT COUNT(*) AS count FROM tree_reservations r CROSS JOIN graph_state s WHERE r.phase = 'complete' AND (r.commit_seq < 1 OR r.commit_seq > s.visible_seq)") : 0;
  const table = role === "ledger" ? "candidate_transactions" : "graph_transactions";
  if (role === "ledger" && !layout.candidate) throw new Error("scalar authority cannot be a candidate ledger");
  const graphBinding = role === "ledger" ? "graph_id" : "NULL AS graph_id";
  const rows = storage.sql.exec(`SELECT rowid AS cursor, tx_id, phase, payload_hash, commit_seq, ${graphBinding} FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT 128`, after).toArray();
  return {state, counts: {pendingGraph, pendingCandidate, pendingReservations, locks, pendingTopology, activeLeases, invalidPublications}, rows};
}
export function shardAuthority(storage: DurableObjectStorage, layout: AuthorityLayout, after: number) {
  const count = (sql: string) => storage.sql.exec<{count: number}>(sql).one().count;
  const prepared = count("SELECT COUNT(*) AS count FROM shard_transactions WHERE status NOT IN ('committed', 'cancelled')");
  const unpublished = layout.publication === "atomic_published" ? count("SELECT COUNT(*) AS count FROM shard_transactions WHERE decision_kind = 'atomic' AND atomic_published != 1") : 0;
  // owner_released is a cached pruning proof, not the owner's actual lock/publication
  // state. I deliberately fills it in maintenance; inspect exact owner witnesses.
  const retainedProofs = layout.publication === "owner_released";
  const cachedProofPending = retainedProofs ? count("SELECT COUNT(*) AS count FROM shard_transactions WHERE status IN ('committed', 'cancelled') AND owner_released != 1") : 0;
  const rows = retainedProofs ? storage.sql.exec(`SELECT rowid AS cursor, tx_id, payload_hash, status, decision_kind, created_at_ms,
    decision_context_json, atomic_commit_seq, atomic_statement_ms, atomic_generation, atomic_directory_epoch, owner_released
    FROM shard_transactions WHERE rowid > ? AND status IN ('committed', 'cancelled') ORDER BY rowid LIMIT 128`, after).toArray() : [];
  const identity = storage.sql.exec("SELECT graph_id, prefix FROM shard_identity").toArray()[0] ?? null;
  return {prepared, unpublished, cachedProofPending, rows, identity};
}
export function participantStage(storage: DurableObjectStorage, txId: string) {
  const identity = storage.sql.exec("SELECT graph_id, prefix, role FROM shard_identity").toArray()[0] ?? null;
  const transactions = storage.sql.exec("SELECT tx_id, payload_hash, status FROM shard_transactions WHERE tx_id = ?", txId).toArray();
  const facts = storage.sql.exec("SELECT tx_id, tx_index, source, entity, field, value_json, retraction FROM fact_log WHERE tx_id = ? ORDER BY tx_index LIMIT 1001", txId).toArray();
  return {identity, transactions, facts}; // Synchronous SELECT only; no proof/recovery invocation.
}
export function ownerWitness(storage: DurableObjectStorage, txId: string) {
  const rows = storage.sql.exec(`SELECT tx_id, payload_hash, ticket_seq, directory_epoch, phase, commit_seq, created_at_ms
    FROM tree_reservations WHERE tx_id = ?`, txId).toArray();
  const state = storage.sql.exec("SELECT visible_seq FROM graph_state WHERE singleton = 1").one();
  const locks = storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM entity_write_locks WHERE tx_id = ?", txId).one().count;
  return {rows, state, locks};
}
