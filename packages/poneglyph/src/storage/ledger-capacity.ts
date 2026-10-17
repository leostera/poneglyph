/**
 * Count retained outcomes against one per-ledger budget. A token row without
 * its journal reserves a second slot so an unrelated write cannot consume the
 * capacity required to finish that token's transaction.
 */
export function retainedLedgerOutcomeCount(storage: DurableObjectStorage): number {
  return storage.sql.exec<{count: number}>(`SELECT
    (SELECT COUNT(*) FROM candidate_transactions)
    + (SELECT COUNT(*) FROM client_request_tokens)
    + (SELECT COUNT(*) FROM client_request_tokens t
       WHERE NOT EXISTS (SELECT 1 FROM candidate_transactions c WHERE c.tx_id = t.tx_id)) AS count`).one().count;
}
