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
export function shardAuthority(storage: DurableObjectStorage, layout: AuthorityLayout) {
  const count = (sql: string) => storage.sql.exec<{count: number}>(sql).one().count;
  const prepared = count("SELECT COUNT(*) AS count FROM shard_transactions WHERE status NOT IN ('committed', 'cancelled')");
  const unpublished = layout.publication === "none" ? 0 : count(layout.publication === "atomic_published"
    ? "SELECT COUNT(*) AS count FROM shard_transactions WHERE decision_kind = 'atomic' AND atomic_published != 1"
    : "SELECT COUNT(*) AS count FROM shard_transactions WHERE status IN ('committed', 'cancelled') AND owner_released != 1");
  return {prepared, unpublished};
}
