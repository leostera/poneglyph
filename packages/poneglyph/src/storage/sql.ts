const FACADE_SCHEMA = [
  `CREATE TABLE graph_facade_identity (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), graph_id TEXT NOT NULL)`,
  `CREATE TABLE graph_safe_frontier (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), frontier INTEGER NOT NULL CHECK (frontier >= 0))`,
  `INSERT INTO graph_safe_frontier (singleton, frontier) VALUES (1, 0)`,
  `CREATE TABLE graph_safe_vector (prefix TEXT PRIMARY KEY, directory_epoch INTEGER NOT NULL CHECK (directory_epoch >= 0),
    visible_seq INTEGER NOT NULL CHECK (visible_seq >= 0))`,
];

// Retained-outcome allocations are checked on every admission, so their
// counts are kept by triggers instead of counting the tables each time.
const LEDGER_COUNT_SCHEMA = [
  `CREATE TABLE ledger_counts (singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    candidates INTEGER NOT NULL CHECK (candidates >= 0), tokens INTEGER NOT NULL CHECK (tokens >= 0))`,
  `INSERT INTO ledger_counts (singleton, candidates, tokens)
    VALUES (1, (SELECT COUNT(*) FROM candidate_transactions), (SELECT COUNT(*) FROM client_request_tokens))`,
  `CREATE TRIGGER ledger_candidates_inserted AFTER INSERT ON candidate_transactions
    BEGIN UPDATE ledger_counts SET candidates = candidates + 1 WHERE singleton = 1; END`,
  `CREATE TRIGGER ledger_candidates_deleted AFTER DELETE ON candidate_transactions
    BEGIN UPDATE ledger_counts SET candidates = candidates - 1 WHERE singleton = 1; END`,
  `CREATE TRIGGER ledger_tokens_inserted AFTER INSERT ON client_request_tokens
    BEGIN UPDATE ledger_counts SET tokens = tokens + 1 WHERE singleton = 1; END`,
  `CREATE TRIGGER ledger_tokens_deleted AFTER DELETE ON client_request_tokens
    BEGIN UPDATE ledger_counts SET tokens = tokens - 1 WHERE singleton = 1; END`,
] as const;

const TREE_COUNT_SCHEMA = [
  `CREATE INDEX tree_reservations_by_expiry ON tree_reservations (created_at_ms) WHERE phase IN ('complete', 'aborted')`,
  `CREATE TABLE tree_counts (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), reservations INTEGER NOT NULL CHECK (reservations >= 0))`,
  `INSERT INTO tree_counts (singleton, reservations) VALUES (1, (SELECT COUNT(*) FROM tree_reservations))`,
  `CREATE TRIGGER tree_reservations_inserted AFTER INSERT ON tree_reservations
    BEGIN UPDATE tree_counts SET reservations = reservations + 1 WHERE singleton = 1; END`,
  `CREATE TRIGGER tree_reservations_deleted AFTER DELETE ON tree_reservations
    BEGIN UPDATE tree_counts SET reservations = reservations - 1 WHERE singleton = 1; END`,
] as const;

const LEDGER_SCHEMA = [
  `CREATE TABLE ledger_context (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), graph_id TEXT NOT NULL, bucket TEXT NOT NULL)`,
  `CREATE TABLE client_request_tokens (
    token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64), payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
    tx_id TEXT NOT NULL UNIQUE, created_at_ms INTEGER NOT NULL, terminal_at_ms INTEGER,
    terminal_status TEXT CHECK (terminal_status IS NULL OR terminal_status IN ('committed', 'aborted'))
  )`,
  `CREATE INDEX client_request_tokens_by_expiry ON client_request_tokens (created_at_ms, token_hash) WHERE terminal_at_ms IS NOT NULL`,
  `CREATE INDEX client_request_tokens_pending ON client_request_tokens (created_at_ms) WHERE terminal_at_ms IS NULL`,
  `CREATE TABLE candidate_transactions (tx_id TEXT PRIMARY KEY, graph_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
    batch_json TEXT NOT NULL, trees_json TEXT NOT NULL, plan_json TEXT, phase TEXT NOT NULL,
    commit_seq INTEGER NOT NULL, statement_time_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
    next_recovery_at_ms INTEGER NOT NULL, local_witness_json TEXT,
    participant_witness INTEGER NOT NULL DEFAULT 0 CHECK (participant_witness IN (0, 1)))`,
  `CREATE INDEX candidate_transactions_by_recovery ON candidate_transactions (next_recovery_at_ms) WHERE phase NOT IN ('complete', 'aborted')`,
  `CREATE INDEX candidate_transactions_by_expiry ON candidate_transactions (created_at_ms) WHERE phase IN ('complete', 'aborted')`,
  ...LEDGER_COUNT_SCHEMA,
];

// Owners hand out publication revisions to many writers at once. A revision
// becomes visible once it and every lower one are done; a held revision (a
// distributed write) stays out of the graph's safe vector until released.
const PUBLICATION_SLOT_SCHEMA = [
  `CREATE TABLE tree_publication_slots (
    tx_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL,
    reservation_ticket INTEGER NOT NULL CHECK (reservation_ticket > 0),
    publication_seq INTEGER NOT NULL UNIQUE CHECK (publication_seq > 0),
    directory_epoch INTEGER NOT NULL CHECK (directory_epoch >= 0), created_at_ms INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open', 'done')), held INTEGER NOT NULL CHECK (held IN (0, 1))
  )`,
] as const;

const TREE_SCHEMA = [
  `CREATE TABLE tree_context (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), prefix TEXT NOT NULL)`,
  `CREATE TABLE tree_reservations (tx_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL,
    entities_json TEXT NOT NULL, ticket_seq INTEGER NOT NULL UNIQUE CHECK (ticket_seq > 0), directory_epoch INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('preparing', 'complete', 'aborted')),
    commit_seq INTEGER NOT NULL DEFAULT 0, created_at_ms INTEGER NOT NULL)`,
  `CREATE INDEX tree_reservations_pending ON tree_reservations (phase) WHERE phase = 'preparing'`,
  `CREATE UNIQUE INDEX tree_reservations_by_publication_seq ON tree_reservations (commit_seq) WHERE phase = 'complete'`,
  ...PUBLICATION_SLOT_SCHEMA,
  ...TREE_COUNT_SCHEMA,
  `CREATE TABLE entity_write_locks (entity TEXT PRIMARY KEY, tx_id TEXT NOT NULL, payload_hash TEXT NOT NULL)`,
  `CREATE INDEX entity_write_locks_by_transaction ON entity_write_locks (tx_id)`,
  `CREATE TABLE IF NOT EXISTS graph_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), graph_id TEXT NOT NULL, routing_version INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS graph_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), visible_seq INTEGER NOT NULL, directory_epoch INTEGER NOT NULL,
    writer_tx_id TEXT, topology_op_id TEXT, next_statement_time_ms INTEGER NOT NULL,
    next_write_seq INTEGER NOT NULL DEFAULT 0 CHECK (next_write_seq >= visible_seq),
    min_retained_seq INTEGER NOT NULL DEFAULT 0 CHECK (min_retained_seq >= 0 AND min_retained_seq <= visible_seq)
  )`,
  `INSERT OR IGNORE INTO graph_state
   (singleton, visible_seq, directory_epoch, writer_tx_id, topology_op_id, next_statement_time_ms)
   VALUES (1, 0, 0, NULL, NULL, 0)`,
  `CREATE TABLE IF NOT EXISTS graph_read_leases (
    read_id TEXT PRIMARY KEY, snapshot_seq INTEGER NOT NULL, directory_epoch INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS graph_read_leases_by_expiry ON graph_read_leases (expires_at_ms, snapshot_seq, directory_epoch)`,
  `CREATE TABLE IF NOT EXISTS graph_splits (
    migration_id TEXT PRIMARY KEY, source_prefix TEXT NOT NULL, source_generation INTEGER NOT NULL,
    left_prefix TEXT NOT NULL, right_prefix TEXT NOT NULL, base_visible_seq INTEGER NOT NULL,
    old_directory_epoch INTEGER NOT NULL, split_epoch INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('copying', 'ready', 'cutover', 'retired')),
    force INTEGER NOT NULL DEFAULT 0, created_at_ms INTEGER NOT NULL
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

const SHARD_SCHEMA_VERSION = 8;
const FACADE_SCHEMA_VERSION = 2;
const LEDGER_SCHEMA_VERSION = 2;
const LEDGER_MIGRATIONS: Readonly<Record<number, readonly string[]>> = {1: LEDGER_COUNT_SCHEMA};
const TREE_SCHEMA_VERSION = 6;

/** Upgrades from a persisted version to the next one, applied in order. */
const TREE_MIGRATIONS: Readonly<Record<number, readonly string[]>> = {
  4: [
    ...PUBLICATION_SLOT_SCHEMA,
    `INSERT INTO tree_publication_slots
      (tx_id, payload_hash, reservation_ticket, publication_seq, directory_epoch, created_at_ms, state, held)
      SELECT g.tx_id, g.payload_hash, g.reservation_ticket, g.publication_seq, g.directory_epoch, g.created_at_ms,
        CASE WHEN r.phase = 'preparing' THEN 'open' ELSE 'done' END, 1
      FROM tree_publication_gates g LEFT JOIN tree_reservations r ON r.tx_id = g.tx_id`,
    `DROP TABLE tree_publication_gates`,
  ],
  5: TREE_COUNT_SCHEMA,
};

type SchemaKind = "g-facade" | "g-ledger" | "g-tree" | "g-shard";

export function ensureFacadeSchema(storage: DurableObjectStorage): void {
  ensureSchema(storage, "g-facade", FACADE_SCHEMA_VERSION, FACADE_SCHEMA);
}

export function ensureLedgerSchema(storage: DurableObjectStorage): void {
  ensureSchema(storage, "g-ledger", LEDGER_SCHEMA_VERSION, LEDGER_SCHEMA, LEDGER_MIGRATIONS);
}

export function ensureTreeSchema(storage: DurableObjectStorage): void {
  ensureSchema(storage, "g-tree", TREE_SCHEMA_VERSION, TREE_SCHEMA, TREE_MIGRATIONS);
}

export function ensureShardSchema(storage: DurableObjectStorage): void {
  ensureSchema(storage, "g-shard", SHARD_SCHEMA_VERSION, SHARD_SCHEMA);
}

function ensureSchema(
  storage: DurableObjectStorage, kind: SchemaKind, version: number, statements: readonly string[],
  migrations: Readonly<Record<number, readonly string[]>> = {},
): void {
  storage.transactionSync(() => {
    const schemaMarkerExists = storage.sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'poneglyph_schema'",
    ).toArray().length > 0;

    if (schemaMarkerExists) {
      const marker = storage.sql.exec<{ kind: string; version: number }>(
        "SELECT kind, version FROM poneglyph_schema WHERE singleton = 1",
      ).toArray()[0];
      if (marker?.kind !== kind || marker.version > version) {
        throw new Error(`unsupported ${kind} Durable Object schema marker; refusing to reinterpret persisted data`);
      }
      for (let from = marker.version; from < version; from++) {
        const steps = migrations[from];
        if (steps === undefined) throw new Error(`no ${kind} schema migration from version ${from}; refusing to reinterpret persisted data`);
        for (const statement of steps) storage.sql.exec(statement);
      }
      if (marker.version !== version) storage.sql.exec("UPDATE poneglyph_schema SET version = ? WHERE singleton = 1", version);
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
      version,
    );
  });
}
