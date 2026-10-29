import { MIN_IDEMPOTENCY_RETENTION_MS, OUTCOME_EVICTION_BATCH } from "./constants.js";
import { LEDGER_OUTCOME_LIMIT } from "./forest.js";

/**
 * Count retained outcomes against one per-ledger budget. A token row without
 * its journal reserves a second slot so an unrelated write cannot consume the
 * capacity required to finish that token's transaction.
 */
/**
 * Makes room by forgetting the oldest terminal outcomes that are past the
 * guaranteed idempotency window (with the request tokens that name them).
 */
export function evictLedgerOutcomes(storage: DurableObjectStorage, now = Date.now()): void {
  const cutoff = now - MIN_IDEMPOTENCY_RETENTION_MS;
  storage.sql.exec(`DELETE FROM client_request_tokens WHERE token_hash IN (
    SELECT token_hash FROM client_request_tokens WHERE terminal_at_ms IS NOT NULL AND created_at_ms < ?
    ORDER BY created_at_ms LIMIT ?)`, cutoff, OUTCOME_EVICTION_BATCH);
  storage.sql.exec(`DELETE FROM candidate_transactions WHERE tx_id IN (
    SELECT tx_id FROM candidate_transactions c WHERE phase IN ('complete', 'aborted') AND created_at_ms < ?
      AND NOT EXISTS (SELECT 1 FROM client_request_tokens t WHERE t.tx_id = c.tx_id)
    ORDER BY created_at_ms LIMIT ?)`, cutoff, OUTCOME_EVICTION_BATCH);
}

export function retainedLedgerOutcomeCount(storage: DurableObjectStorage): number {
  // Trigger-kept counts bound the exact figure from above (a token counts at
  // most twice); only near the allocation is it worth counting exactly.
  const counts = storage.sql.exec<{candidates: number; tokens: number}>("SELECT candidates, tokens FROM ledger_counts WHERE singleton = 1").one();
  const upperBound = counts.candidates + 2 * counts.tokens;
  if (upperBound + 2 < LEDGER_OUTCOME_LIMIT) return upperBound;
  return storage.sql.exec<{count: number}>(`SELECT
    (SELECT COUNT(*) FROM candidate_transactions)
    + (SELECT COUNT(*) FROM client_request_tokens)
    + (SELECT COUNT(*) FROM client_request_tokens t
       WHERE NOT EXISTS (SELECT 1 FROM candidate_transactions c WHERE c.tx_id = t.tx_id)) AS count`).one().count;
}
