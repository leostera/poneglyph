import type { Uri } from "../domain/identifiers.js";
import { accountStorage } from "./capacity.js";
import { TRANSACTION_IDEMPOTENCY_RETENTION_MS } from "./constants.js";
import { TREE_OUTCOME_LIMIT } from "./forest.js";

export type OwnerWriteTicket = Readonly<{commitSeq: number; directoryEpoch: number}>;
type Reservation = Readonly<{payload_hash: string; entities_json: string; ticket_seq: number;
  directory_epoch: number; phase: string; created_at_ms: number}>;
type OwnerState = Readonly<{visible_seq: number; next_write_seq: number; directory_epoch: number; topology_op_id: string | null}>;

export class OwnerWriteError extends Error {
  constructor(readonly status: number, message: string, readonly retryable = false) { super(message); }
}

// Entity is the conflict unit because one mutation rewrites its full projection
// and every concrete EA/AV record remains entity/fact qualified. An owner is
// only a short-lived SQLite serialization boundary, never a transaction mutex.
export class OwnerWrites {
  constructor(private readonly storage: DurableObjectStorage) {}

  hasWriters(): boolean {
    return this.storage.sql.exec(`SELECT 1 FROM tree_reservations WHERE phase = 'preparing'
      UNION ALL SELECT 1 FROM entity_write_locks LIMIT 1`).toArray().length > 0;
  }

  reserve(txId: string, hash: string, entities: readonly Uri[], epoch: number, identityTime: number): OwnerWriteTicket {
    const keys = JSON.stringify(entities);
    return this.storage.transactionSync(() => {
      const now = Date.now();
      this.storage.sql.exec("DELETE FROM tree_reservations WHERE phase IN ('complete', 'aborted') AND created_at_ms < ?", now - TRANSACTION_IDEMPOTENCY_RETENTION_MS);
      const prior = this.read(txId), state = this.state();
      if (prior && (prior.payload_hash !== hash || prior.entities_json !== keys || prior.created_at_ms !== identityTime)) throw new OwnerWriteError(409, "owner reservation identity or entity-set conflict");
      // A completed old owner outcome must not become half of a newly admitted
      // transaction after the graph-wide identity window expires.
      if (prior && prior.phase !== "preparing") throw new OwnerWriteError(409, "owner outcome remains retained");
      if (state.directory_epoch !== epoch) throw new OwnerWriteError(409, "provisional owner epoch changed", true);
      if (state.topology_op_id !== null || this.hasReadLease()) throw new OwnerWriteError(423, "owner read/topology fence is active", true);
      if (prior) {
        if (prior.directory_epoch !== state.directory_epoch) throw new OwnerWriteError(409, "pending owner reservation lost its directory epoch");
        for (const entity of entities) this.assertLock(entity, txId, hash);
        const count = this.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM entity_write_locks WHERE tx_id = ?", txId).one().count;
        if (count !== entities.length) throw new OwnerWriteError(409, "pending owner entity set is inconsistent");
        return {commitSeq: prior.ticket_seq, directoryEpoch: prior.directory_epoch};
      }
      for (const entity of entities) {
        if (this.storage.sql.exec("SELECT 1 FROM entity_write_locks WHERE entity = ?", entity).toArray().length)
          throw new OwnerWriteError(423, "entity is reserved by another transaction", true);
      }
      const count = this.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM tree_reservations").one().count;
      if (count >= TREE_OUTCOME_LIMIT) throw new OwnerWriteError(429, "owner retained-outcome allocation is full");
      const encoder = new TextEncoder();
      const lockBytes = entities.reduce((sum, entity) => sum + encoder.encode(entity).byteLength + encoder.encode(txId).byteLength + 256, 0);
      const capacity = accountStorage(this.storage.sql.databaseSize, {factLogBytes: 0, activeIndexBytes: 0,
        projectionBytes: 0, transactionStagingBytes: lockBytes * 2 + encoder.encode(keys).byteLength + 2048});
      if (!capacity.canAdmit) throw new OwnerWriteError(413, "owner lock metadata exceeds accounted capacity");
      if (!Number.isSafeInteger(state.next_write_seq) || state.next_write_seq >= Number.MAX_SAFE_INTEGER)
        throw new OwnerWriteError(429, "owner write ticket space is exhausted");
      const ticket = state.next_write_seq + 1;
      this.storage.sql.exec(`INSERT INTO tree_reservations
        (tx_id, payload_hash, entities_json, ticket_seq, directory_epoch, phase, created_at_ms)
        VALUES (?, ?, ?, ?, ?, 'preparing', ?)`, txId, hash, keys, ticket, state.directory_epoch, identityTime);
      for (const entity of entities) this.storage.sql.exec("INSERT INTO entity_write_locks (entity, tx_id, payload_hash) VALUES (?, ?, ?)", entity, txId, hash);
      this.storage.sql.exec("UPDATE graph_state SET next_write_seq = ? WHERE singleton = 1", ticket);
      return {commitSeq: ticket, directoryEpoch: state.directory_epoch};
    });
  }

  release(txId: string, hash: string, identityTime: number, abort: boolean): void {
    this.storage.transactionSync(() => {
      const row = this.read(txId);
      if (!row) return;
      if (row.payload_hash !== hash || row.created_at_ms !== identityTime) throw new OwnerWriteError(409, "owner release identity conflict");
      if (row.phase !== "preparing") return;
      this.assertOwnedSet(row, txId, hash);
      this.storage.sql.exec("DELETE FROM entity_write_locks WHERE tx_id = ? AND payload_hash = ?", txId, hash);
      if (abort) this.storage.sql.exec("UPDATE tree_reservations SET phase = 'aborted' WHERE tx_id = ?", txId);
      else this.storage.sql.exec("DELETE FROM tree_reservations WHERE tx_id = ?", txId);
    });
  }

  publish(txId: string, hash: string, seq: number, identityTime: number): void {
    this.storage.transactionSync(() => {
      const row = this.read(txId);
      if (!row || row.payload_hash !== hash || row.ticket_seq !== seq || row.created_at_ms !== identityTime) throw new OwnerWriteError(409, "owner publication does not match its ticket");
      if (row.phase === "complete") return;
      if (row.phase !== "preparing" || row.directory_epoch !== this.state().directory_epoch)
        throw new OwnerWriteError(409, "owner publication lost its reservation");
      this.assertOwnedSet(row, txId, hash);
      this.storage.sql.exec("UPDATE tree_reservations SET phase = 'complete', commit_seq = ? WHERE tx_id = ?", seq, txId);
      // Lower tickets may complete after higher ones. Readers remain fenced
      // until every entity reservation is gone; a max watermark is not a cut
      // while any lower-ticket transaction is still partially applied.
      this.storage.sql.exec("UPDATE graph_state SET visible_seq = MAX(visible_seq, ?) WHERE singleton = 1", seq);
      this.storage.sql.exec("DELETE FROM entity_write_locks WHERE tx_id = ? AND payload_hash = ?", txId, hash);
    });
  }

  authorityReleased(txId: string, hash: string, seq: number, epoch: number, identityTime: number, decision: "committed" | "aborted"): boolean {
    const row = this.read(txId);
    // Replacement itself is a terminal-predecessor witness, not a watermark.
    // New identity locks must not prevent finalizing an old pin and deadlock
    // reuse of that ID at its leaf. Pending reservations are never replaced.
    if (row && row.ticket_seq > seq && row.created_at_ms > identityTime &&
        identityTime < Date.now() - TRANSACTION_IDEMPOTENCY_RETENTION_MS) return true;
    const locks = this.storage.sql.exec("SELECT 1 FROM entity_write_locks WHERE tx_id = ? LIMIT 1", txId).toArray();
    if (locks.length) return false;
    // Only terminal records are pruned; this inference depends on that invariant.
    if (!row) return true;
    return row.payload_hash === hash && row.ticket_seq === seq && row.directory_epoch === epoch &&
      row.created_at_ms === identityTime && row.phase === (decision === "committed" ? "complete" : "aborted");
  }

  audit(): Readonly<{entityLockCount: number; ownerTicketAnomalies: number}> {
    const entityLockCount = this.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM entity_write_locks").one().count;
    const invalidLocks = this.storage.sql.exec<{count: number}>(`SELECT COUNT(*) AS count FROM entity_write_locks l
      LEFT JOIN tree_reservations r ON r.tx_id = l.tx_id AND r.payload_hash = l.payload_hash
      WHERE r.tx_id IS NULL OR r.phase != 'preparing'
        OR NOT EXISTS (SELECT 1 FROM json_each(r.entities_json) e WHERE e.value = l.entity)`).one().count;
    const invalidTickets = this.storage.sql.exec<{count: number}>(`SELECT COUNT(*) AS count FROM tree_reservations r, graph_state s
      WHERE r.ticket_seq > s.next_write_seq
        OR (r.phase = 'complete' AND (r.commit_seq != r.ticket_seq OR r.commit_seq > s.visible_seq))
        OR (r.phase = 'preparing' AND (SELECT COUNT(*) FROM entity_write_locks l WHERE l.tx_id = r.tx_id) != json_array_length(r.entities_json))`).one().count;
    return {entityLockCount, ownerTicketAnomalies: invalidLocks + invalidTickets};
  }

  private assertOwnedSet(row: Reservation, txId: string, hash: string): void {
    const entities = JSON.parse(row.entities_json) as string[];
    for (const entity of entities) this.assertLock(entity, txId, hash);
    const count = this.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM entity_write_locks WHERE tx_id = ?", txId).one().count;
    if (count !== entities.length) throw new OwnerWriteError(409, "owner lock membership changed");
  }
  private assertLock(entity: string, txId: string, hash: string): void {
    const lock = this.storage.sql.exec<{tx_id: string; payload_hash: string}>("SELECT tx_id, payload_hash FROM entity_write_locks WHERE entity = ?", entity).toArray()[0];
    if (lock?.tx_id !== txId || lock.payload_hash !== hash) throw new OwnerWriteError(409, "persisted transaction lost its entity lock");
  }
  private read(txId: string): Reservation | undefined {
    return this.storage.sql.exec<Reservation>("SELECT * FROM tree_reservations WHERE tx_id = ?", txId).toArray()[0];
  }
  private state(): OwnerState {
    return this.storage.sql.exec<OwnerState>("SELECT visible_seq, next_write_seq, directory_epoch, topology_op_id FROM graph_state WHERE singleton = 1").one();
  }
  private hasReadLease(): boolean {
    return this.storage.sql.exec("SELECT 1 FROM graph_read_leases WHERE expires_at_ms > ? LIMIT 1", Date.now()).toArray().length > 0;
  }
}
