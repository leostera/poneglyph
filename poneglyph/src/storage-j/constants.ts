export const ROUTING_VERSION = 11;

export const MAX_DIRECTORY_DEPTH = 256;
export const MAX_DIRECTORY_LOOKUP_HOPS = MAX_DIRECTORY_DEPTH + 1;
export const MAX_TRANSACTION_PARTICIPANTS = 32;
export const MAX_QUERY_SHARD_FANOUT = 256;
export const MAX_QUERY_DIRECTORY_NODES = 511;
export const MAX_SPLITS_PER_WRITE = 8;

export const MAX_ACCOUNTED_BYTES_PER_DO = 8_000_000_000;
export const TRANSACTION_IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_RETAINED_TRANSACTION_OUTCOMES = 100_000;
export const SHARD_SPLIT_TRIGGER_BYTES = 5_000_000_000;
export const MINIMUM_UNCERTAINTY_HEADROOM_BYTES = 2_000_000_000;
export const MINIMUM_WAL_RESERVE_BYTES = 64_000_000;

// SQLite DO queries support at most 100 bound parameters per statement.
// This limits lookup pages, not the number of facts in a transaction.
export const MAX_SQL_BINDINGS = 100;
export const MAX_TRANSACTION_FACTS = 1_000;
export const MAX_TRANSACTION_BYTES = 1_000_000;
export const MAX_ACTIVE_FACTS_PER_ENTITY = 10_000;
export const MAX_ENTITY_FIELDS = 5_000;
export const MAX_QUERY_RESULTS = 2_000;
export const MAX_QUERY_TUPLES = 50_000;
export const MAX_QUERY_SHARD_REQUESTS = 20_000;
export const MAX_QUERY_SCAN_BYTES = 20_000_000;
export const MAX_QUERY_RESPONSE_BYTES = 2_000_000;
export const MAX_READ_LEASES = 128;
export const READ_LEASE_TTL_MS = 30_000;
export const QUERY_TIMEOUT_MS = 20_000;
export const SHARD_SCAN_PAGE_SIZE = 128;
export const SPLIT_COPY_PAGE_SIZE = 128;
