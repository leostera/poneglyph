const COORDINATOR_SCHEMA = [
  `CREATE TABLE ledger_context (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), graph_id TEXT NOT NULL, bucket TEXT NOT NULL)`,
  `CREATE TABLE tree_context (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), prefix TEXT NOT NULL)`,
  `CREATE TABLE tree_reservations (tx_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL,
    entities_json TEXT NOT NULL, ticket_seq INTEGER NOT NULL UNIQUE CHECK (ticket_seq > 0), directory_epoch INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('preparing', 'complete', 'aborted')),
    commit_seq INTEGER NOT NULL DEFAULT 0, created_at_ms INTEGER NOT NULL)`,
  `CREATE INDEX tree_reservations_pending ON tree_reservations (phase) WHERE phase = 'preparing'`,
  `CREATE TABLE entity_write_locks (entity TEXT PRIMARY KEY, tx_id TEXT NOT NULL, payload_hash TEXT NOT NULL)`,
  `CREATE INDEX entity_write_locks_by_transaction ON entity_write_locks (tx_id)`,
  `CREATE TABLE candidate_transactions (tx_id TEXT PRIMARY KEY, graph_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
    batch_json TEXT NOT NULL, trees_json TEXT NOT NULL, plan_json TEXT, phase TEXT NOT NULL,
    commit_seq INTEGER NOT NULL, statement_time_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
    next_recovery_at_ms INTEGER NOT NULL, local_witness_json TEXT,
    participant_witness INTEGER NOT NULL DEFAULT 0 CHECK (participant_witness IN (0, 1)))`,
  `CREATE INDEX candidate_transactions_by_recovery ON candidate_transactions (next_recovery_at_ms) WHERE phase NOT IN ('complete', 'aborted')`,
  `CREATE INDEX candidate_transactions_by_expiry ON candidate_transactions (created_at_ms) WHERE phase IN ('complete', 'aborted')`,
  `CREATE TABLE IF NOT EXISTS graph_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    graph_id TEXT NOT NULL,
    routing_version INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS graph_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    visible_seq INTEGER NOT NULL,
    directory_epoch INTEGER NOT NULL,
    writer_tx_id TEXT,
    topology_op_id TEXT,
    next_statement_time_ms INTEGER NOT NULL,
    next_write_seq INTEGER NOT NULL DEFAULT 0 CHECK (next_write_seq >= visible_seq)
  )`,
  `INSERT OR IGNORE INTO graph_state
   (singleton, visible_seq, directory_epoch, writer_tx_id, topology_op_id, next_statement_time_ms)
   VALUES (1, 0, 0, NULL, NULL, 0)`,
  `CREATE TABLE IF NOT EXISTS graph_transactions (
    tx_id TEXT PRIMARY KEY,
    payload_hash TEXT NOT NULL,
    batch_json TEXT,
    participants_json TEXT NOT NULL,
    directory_epoch INTEGER NOT NULL,
    statement_time_ms INTEGER NOT NULL,
    commit_seq INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('preparing', 'committing', 'cancelling', 'complete', 'aborted')),
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS graph_read_leases (
    read_id TEXT PRIMARY KEY,
    snapshot_seq INTEGER NOT NULL,
    directory_epoch INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS graph_read_leases_by_expiry
   ON graph_read_leases (expires_at_ms, snapshot_seq, directory_epoch)`,
  `CREATE TABLE IF NOT EXISTS graph_splits (
    migration_id TEXT PRIMARY KEY,
    source_prefix TEXT NOT NULL,
    source_generation INTEGER NOT NULL,
    left_prefix TEXT NOT NULL,
    right_prefix TEXT NOT NULL,
    base_visible_seq INTEGER NOT NULL,
    old_directory_epoch INTEGER NOT NULL,
    split_epoch INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('copying', 'ready', 'cutover', 'retired')),
    force INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS graph_splits_by_phase ON graph_splits (phase, created_at_ms)`,
];

const SHARD_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS shard_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    graph_id TEXT NOT NULL,
    prefix TEXT NOT NULL,
    generation INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('leaf', 'router')),
    split_epoch INTEGER,
    child_zero_prefix TEXT,
    child_one_prefix TEXT,
    migration_id TEXT,
    migration_state TEXT NOT NULL CHECK (migration_state IN ('active', 'copying', 'ready', 'retired'))
  )`,
  `CREATE TABLE IF NOT EXISTS shard_transactions (
    tx_id TEXT PRIMARY KEY,
    payload_hash TEXT NOT NULL,
    payload_json TEXT,
    status TEXT NOT NULL CHECK (status IN ('prepared', 'committed', 'cancelled')),
    reserved_mutation_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_mutation_bytes >= 0),
    decision_kind TEXT NOT NULL DEFAULT 'distributed' CHECK (decision_kind IN ('distributed', 'atomic')),
    decision_context_json TEXT,
    atomic_commit_seq INTEGER, atomic_statement_ms INTEGER, atomic_fact_count INTEGER,
    atomic_generation INTEGER, atomic_directory_epoch INTEGER,
    atomic_rejection_status INTEGER, atomic_error TEXT,
    owner_released INTEGER NOT NULL DEFAULT 0 CHECK (owner_released IN (0, 1)),
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX shard_outcome_pending ON shard_transactions (created_at_ms) WHERE status IN ('committed', 'cancelled') AND owner_released = 0`,
  `CREATE INDEX shard_outcome_expiry ON shard_transactions (created_at_ms) WHERE status IN ('committed', 'cancelled') AND owner_released = 1`,
  `CREATE TABLE IF NOT EXISTS fact_log (
    fact_id TEXT PRIMARY KEY,
    tx_id TEXT NOT NULL,
    tx_index INTEGER NOT NULL,
    commit_seq INTEGER NOT NULL,
    source TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_hash TEXT NOT NULL,
    field TEXT NOT NULL,
    value_json TEXT NOT NULL,
    retraction INTEGER NOT NULL,
    stated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS fact_log_by_entity_hash
   ON fact_log (entity_hash, entity, fact_id)`,
  `CREATE TABLE IF NOT EXISTS active_facts (
    source TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_hash TEXT NOT NULL,
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
  `CREATE INDEX IF NOT EXISTS active_facts_by_entity_hash
   ON active_facts (entity_hash, entity, valid_from_seq, valid_to_seq)`,
  `CREATE INDEX IF NOT EXISTS active_facts_by_field_snapshot
   ON active_facts (field, valid_from_seq, valid_to_seq)`,
  `CREATE INDEX IF NOT EXISTS active_facts_by_entity_field_snapshot
   ON active_facts (entity, field, valid_from_seq, valid_to_seq)`,
  `CREATE TABLE IF NOT EXISTS active_values (
    fact_id TEXT NOT NULL,
    value_index INTEGER NOT NULL,
    source TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_hash TEXT NOT NULL,
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
  `CREATE INDEX IF NOT EXISTS active_values_by_entity_hash
   ON active_values (entity_hash, entity, fact_id, value_index)`,
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
    entity_hash TEXT NOT NULL,
    fields_json TEXT NOT NULL,
    last_tx_id TEXT NOT NULL,
    valid_from_seq INTEGER NOT NULL,
    valid_to_seq INTEGER,
    PRIMARY KEY (entity, valid_from_seq)
  )`,
  `CREATE INDEX IF NOT EXISTS entity_versions_by_entity_hash
   ON entity_versions (entity_hash, entity, valid_from_seq, valid_to_seq)`,
  `CREATE INDEX IF NOT EXISTS entity_versions_by_snapshot
   ON entity_versions (entity, valid_from_seq, valid_to_seq)`,
  `CREATE TABLE IF NOT EXISTS migration_import_pages (
    migration_id TEXT NOT NULL,
    table_name TEXT NOT NULL,
    target_prefix TEXT NOT NULL,
    page_number INTEGER NOT NULL,
    page_hash TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    PRIMARY KEY (migration_id, table_name, target_prefix, page_number)
  )`,
  `CREATE TABLE IF NOT EXISTS shard_accounting (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    migration_reserved_bytes INTEGER NOT NULL DEFAULT 0,
    synthetic_size_bytes INTEGER NOT NULL DEFAULT 0
  )`,
  `INSERT OR IGNORE INTO shard_accounting (singleton, migration_reserved_bytes) VALUES (1, 0)`,
];

const PONEGLYPH_SCHEMA_VERSION = 8;

// Independent H persistence cannot reinterpret any earlier candidate schema.
type SchemaKind = "h-coordinator" | "h-shard";

export function ensureCoordinatorSchema(storage: DurableObjectStorage): void {
  ensureSchema(storage, "h-coordinator", COORDINATOR_SCHEMA);
}

export function ensureShardSchema(storage: DurableObjectStorage): void {
  ensureSchema(storage, "h-shard", SHARD_SCHEMA);
}

function ensureSchema(storage: DurableObjectStorage, kind: SchemaKind, statements: readonly string[]): void {
  storage.transactionSync(() => {
    const schemaMarkerExists = storage.sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'poneglyph_schema'",
    ).toArray().length > 0;

    if (schemaMarkerExists) {
      const marker = storage.sql.exec<{ kind: string; version: number }>(
        "SELECT kind, version FROM poneglyph_schema WHERE singleton = 1",
      ).toArray()[0];
      if (marker?.kind !== kind || marker.version !== PONEGLYPH_SCHEMA_VERSION) {
        throw new Error(`unsupported ${kind} Durable Object schema marker; refusing to reinterpret persisted data`);
      }
      return;
    }

    const existingTables = storage.sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).toArray();
    if (existingTables.length > 0) {
      throw new Error(
        `existing ${kind} Durable Object SQLite schema is unversioned; automatic schema upgrade/import is unsupported, use a fresh namespace`,
      );
    }

    for (const statement of statements) storage.sql.exec(statement);
    storage.sql.exec(
      `CREATE TABLE poneglyph_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        kind TEXT NOT NULL,
        version INTEGER NOT NULL
      )`,
    );
    storage.sql.exec(
      "INSERT INTO poneglyph_schema (singleton, kind, version) VALUES (1, ?, ?)",
      kind,
      PONEGLYPH_SCHEMA_VERSION,
    );
  });
}
