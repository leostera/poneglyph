// Local read-only adapter over the common fact/index table representation.
// Never exported by the production Worker and never called by timed writes.
export function auditFactStorage(storage: DurableObjectStorage, after: number) {
  const sql = storage.sql;
  const identity = sql.exec("SELECT * FROM shard_identity").toArray();
  if (identity[0]?.["role"] === "router") return { identity, facts: [] };
  return {
    identity,
    facts: sql.exec("SELECT rowid AS ordinal, tx_id, source, entity, field, value_json, retraction FROM fact_log WHERE rowid > ? ORDER BY rowid LIMIT 512", after).toArray(),
    ...(after === 0 ? {
      active: sql.exec("SELECT COUNT(*) AS count FROM active_facts WHERE valid_to_seq IS NULL").toArray(),
      maxCommitSeq: sql.exec("SELECT COALESCE(MAX(commit_seq), 0) AS value FROM fact_log").toArray(),
      mismatchedFacts: sql.exec(`SELECT COUNT(*) AS count FROM active_facts f LEFT JOIN fact_log l ON l.fact_id = f.fact_id
        WHERE f.valid_to_seq IS NULL AND (l.fact_id IS NULL OR l.retraction != 0 OR f.source != l.source OR f.entity != l.entity
        OR f.field != l.field OR f.value_json != l.value_json OR f.tx_id != l.tx_id OR f.valid_from_seq != l.commit_seq)`).toArray(),
      mismatchedDatalog: sql.exec(`SELECT COUNT(*) AS count FROM active_values WHERE valid_to_seq IS NULL AND
        (datalog_value != json_extract(value_json, '$.value') OR datalog_type != CASE json_extract(value_json, '$.type') WHEN 'number' THEN 'integer' ELSE 'string' END)`).toArray(),
      values: sql.exec("SELECT COUNT(*) AS count FROM active_values WHERE valid_to_seq IS NULL").toArray(),
      mismatchedValues: sql.exec(`SELECT COUNT(*) AS count FROM active_values v JOIN active_facts f ON f.fact_id = v.fact_id
        WHERE v.valid_to_seq IS NULL AND f.valid_to_seq IS NULL AND
        (v.entity != f.entity OR v.field != f.field OR v.source != f.source OR v.value_json != f.value_json OR v.value_key != f.value_json OR v.value_index != 0 OR v.valid_from_seq != f.valid_from_seq)`).toArray(),
      missingValues: sql.exec(`SELECT COUNT(*) AS count FROM active_facts f WHERE f.valid_to_seq IS NULL AND NOT EXISTS
        (SELECT 1 FROM active_values v WHERE v.fact_id = f.fact_id AND v.valid_to_seq IS NULL)`).toArray(),
      orphanValues: sql.exec(`SELECT COUNT(*) AS count FROM active_values v WHERE v.valid_to_seq IS NULL AND NOT EXISTS
        (SELECT 1 FROM active_facts f WHERE f.source = v.source AND f.entity = v.entity AND f.field = v.field
          AND f.value_json = v.value_json AND f.valid_to_seq IS NULL AND f.fact_id = v.fact_id)`).toArray(),
      statuses: sql.exec("SELECT status, COUNT(*) AS count FROM shard_transactions GROUP BY status").toArray(),
      databaseBytes: sql.databaseSize,
    } : {}),
  };
}
