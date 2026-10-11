const COORDINATOR_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS graph_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    graph_id TEXT NOT NULL,
    routing_version INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS graph_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    visible_seq INTEGER NOT NULL,
    writer_tx_id TEXT,
    next_statement_time_ms INTEGER NOT NULL
  )`,
  `INSERT OR IGNORE INTO graph_state (singleton, visible_seq, writer_tx_id, next_statement_time_ms)
   VALUES (1, 0, NULL, 0)`,
  `CREATE TABLE IF NOT EXISTS graph_transactions (
    tx_id TEXT PRIMARY KEY,
    payload_hash TEXT NOT NULL,
    batch_json TEXT,
    participants_json TEXT NOT NULL,
    statement_time_ms INTEGER NOT NULL,
    commit_seq INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('preparing', 'committing', 'cancelling', 'complete', 'aborted')),
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS graph_read_leases (
    read_id TEXT PRIMARY KEY,
    snapshot_seq INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS graph_read_leases_by_expiry
   ON graph_read_leases (expires_at_ms, snapshot_seq)`,
];

const SHARD_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS shard_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    graph_id TEXT NOT NULL,
    shard_index INTEGER NOT NULL,
    routing_version INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS shard_transactions (
    tx_id TEXT PRIMARY KEY,
    payload_hash TEXT NOT NULL,
    payload_json TEXT,
    status TEXT NOT NULL CHECK (status IN ('prepared', 'committed', 'cancelled'))
  )`,
  `CREATE TABLE IF NOT EXISTS fact_log (
    fact_id TEXT PRIMARY KEY,
    tx_id TEXT NOT NULL,
    source TEXT NOT NULL,
    entity TEXT NOT NULL,
    field TEXT NOT NULL,
    value_json TEXT NOT NULL,
    retraction INTEGER NOT NULL,
    stated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS fact_log_by_entity_tx
   ON fact_log (entity, tx_id, fact_id)`,
  `CREATE TABLE IF NOT EXISTS active_facts (
    source TEXT NOT NULL,
    entity TEXT NOT NULL,
    field TEXT NOT NULL,
    value_json TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    tx_id TEXT NOT NULL,
    stated_at TEXT NOT NULL,
    valid_from_seq INTEGER NOT NULL,
    valid_to_seq INTEGER,
    PRIMARY KEY (source, entity, field, value_json, valid_from_seq, fact_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS active_facts_by_current_tuple
   ON active_facts (source, entity, field, value_json) WHERE valid_to_seq IS NULL`,
  `CREATE INDEX IF NOT EXISTS active_facts_by_field_snapshot
   ON active_facts (field, valid_from_seq, valid_to_seq)`,
  `CREATE INDEX IF NOT EXISTS active_facts_by_entity_field_snapshot
   ON active_facts (entity, field, valid_from_seq, valid_to_seq)`,
  `CREATE TABLE IF NOT EXISTS active_values (
    fact_id TEXT NOT NULL,
    value_index INTEGER NOT NULL,
    source TEXT NOT NULL,
    entity TEXT NOT NULL,
    field TEXT NOT NULL,
    datalog_type TEXT NOT NULL,
    datalog_value TEXT NOT NULL,
    value_key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    tx_id TEXT NOT NULL,
    stated_at TEXT NOT NULL,
    valid_from_seq INTEGER NOT NULL,
    valid_to_seq INTEGER,
    PRIMARY KEY (fact_id, value_index, valid_from_seq)
  )`,
  `CREATE INDEX IF NOT EXISTS active_values_by_field_snapshot
   ON active_values (field, valid_from_seq, valid_to_seq, entity)`,
  `CREATE INDEX IF NOT EXISTS active_values_by_field_page
   ON active_values (field, entity, fact_id, value_index, valid_from_seq, valid_to_seq)`,
  `CREATE INDEX IF NOT EXISTS active_values_by_field_entity_snapshot
   ON active_values (field, entity, valid_from_seq, valid_to_seq)`,
  `CREATE INDEX IF NOT EXISTS active_values_by_field_value_snapshot
   ON active_values (field, value_key, valid_from_seq, valid_to_seq, entity)`,
  `CREATE INDEX IF NOT EXISTS active_values_by_field_entity_value_snapshot
   ON active_values (field, entity, value_key, valid_from_seq, valid_to_seq)`,
  `CREATE TABLE IF NOT EXISTS entity_versions (
    entity TEXT NOT NULL,
    fields_json TEXT NOT NULL,
    last_tx_id TEXT NOT NULL,
    valid_from_seq INTEGER NOT NULL,
    valid_to_seq INTEGER,
    PRIMARY KEY (entity, valid_from_seq)
  )`,
  `CREATE INDEX IF NOT EXISTS entity_versions_by_snapshot
   ON entity_versions (entity, valid_from_seq, valid_to_seq)`,
];

export function ensureCoordinatorSchema(storage: DurableObjectStorage): void {
  for (const statement of COORDINATOR_SCHEMA) storage.sql.exec(statement);
}

export function ensureShardSchema(storage: DurableObjectStorage): void {
  for (const statement of SHARD_SCHEMA) storage.sql.exec(statement);
}
