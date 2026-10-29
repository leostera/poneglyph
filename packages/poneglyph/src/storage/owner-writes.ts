import type { Uri } from "../domain/identifiers.js";
import { accountStorage } from "./capacity.js";
import { MIN_IDEMPOTENCY_RETENTION_MS, OUTCOME_EVICTION_BATCH, TRANSACTION_IDEMPOTENCY_RETENTION_MS } from "./constants.js";
import { TREE_OUTCOME_LIMIT } from "./forest.js";

export type OwnerReservationTicket = Readonly<{reservationTicket: number; directoryEpoch: number}>;
export type OwnerPublicationGate = Readonly<{reservationTicket: number; publicationSeq: number; directoryEpoch: number}>;
type Reservation = Readonly<{payload_hash: string; entities_json: string; ticket_seq: number;
  directory_epoch: number; phase: string; commit_seq: number; created_at_ms: number}>;
type PublicationSlot = Readonly<{tx_id: string; payload_hash: string; reservation_ticket: number;
  publication_seq: number; directory_epoch: number; created_at_ms: number; state: "open" | "done"; held: number}>;
/** Where an owner's publication stands: applied revisions, and those the graph's safe vector may show. */
export type OwnerFrontier = Readonly<{visibleSeq: number; publishableSeq: number; directoryEpoch: number}>;

/** Open publication revisions per owner; beyond this, writers wait for earlier ones to finish. */
const MAX_OPEN_PUBLICATION_SLOTS = 4_096;
type OwnerState = Readonly<{visible_seq: number; next_write_seq: number; directory_epoch: number; topology_op_id: string | null}>;

/** The lock's answer when a writer planned against an old owner directory. */
export const STALE_OWNER_EPOCH = "provisional owner epoch changed";
/** The lock's answer while the owner is fenced for a split. */
export const OWNER_TOPOLOGY_FENCED = "owner topology fence is active";

export class OwnerWriteError extends Error {
  constructor(readonly status: number, message: string, readonly retryable = false) { super(message); }
}

// Entity is the conflict unit because one mutation rewrites its full projection
// and every concrete EA/AV record remains entity/fact qualified. Disjoint
// reservations coexist, and so do their publications: each writer takes the
// next publication revision, and an owner's visible revision advances over the
// contiguous prefix of finished ones. Entity locks keep a single entity's
// writes in revision order.
/** Reservations between sweeps of expired terminal outcomes. */
const SWEEP_EVERY = 64;

export class OwnerWrites {
  private reservationsSinceSweep = SWEEP_EVERY;
  constructor(private readonly storage: DurableObjectStorage) {}

  hasWriters(): boolean {
    return this.storage.sql.exec(`SELECT 1 FROM tree_reservations WHERE phase = 'preparing'
      UNION ALL SELECT 1 FROM entity_write_locks
      UNION ALL SELECT 1 FROM tree_publication_slots LIMIT 1`).toArray().length > 0;
  }

  reserve(txId: string, hash: string, entities: readonly Uri[], epoch: number, identityTime: number): OwnerReservationTicket & Readonly<{fresh?: true}> {
    const keys = JSON.stringify(entities);
    return this.storage.transactionSync(() => {
      const now = Date.now();
      // Expired outcomes only cost space, and the allocation check below
      // evicts when full, so sweeping every call is wasted work.
      if (++this.reservationsSinceSweep >= SWEEP_EVERY) {
        this.reservationsSinceSweep = 0;
        this.storage.sql.exec(`DELETE FROM tree_reservations WHERE tx_id IN (
          SELECT tx_id FROM tree_reservations WHERE phase IN ('complete', 'aborted') AND created_at_ms < ?
            AND tx_id NOT IN (SELECT tx_id FROM tree_publication_slots) LIMIT 1000)`, now - TRANSACTION_IDEMPOTENCY_RETENTION_MS);
      }
      let prior = this.read(txId);
      const state = this.state();
      // An expired terminal predecessor of this ID is forgotten now, not at the next sweep.
      if (prior && prior.phase !== "preparing" && prior.created_at_ms < now - TRANSACTION_IDEMPOTENCY_RETENTION_MS && !this.readSlot(txId)) {
        this.storage.sql.exec("DELETE FROM tree_reservations WHERE tx_id = ?", txId);
        prior = undefined;
      }
      if (prior && (prior.payload_hash !== hash || prior.entities_json !== keys || prior.created_at_ms !== identityTime)) throw new OwnerWriteError(409, "owner reservation identity or entity-set conflict");
      // A completed old owner outcome must not become half of a newly admitted
      // transaction after the graph-wide identity window expires.
      if (prior && prior.phase !== "preparing") throw new OwnerWriteError(409, "owner outcome remains retained");
      if (state.directory_epoch !== epoch) throw new OwnerWriteError(409, STALE_OWNER_EPOCH, true);
      if (prior) {
        if (prior.directory_epoch !== state.directory_epoch) throw new OwnerWriteError(409, "pending owner reservation lost its directory epoch");
        for (const entity of entities) this.assertLock(entity, txId, hash);
        const count = this.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM entity_write_locks WHERE tx_id = ?", txId).one().count;
        if (count !== entities.length) throw new OwnerWriteError(409, "pending owner entity set is inconsistent");
        return {reservationTicket: prior.ticket_seq, directoryEpoch: prior.directory_epoch};
      }
      if (state.topology_op_id !== null) throw new OwnerWriteError(423, OWNER_TOPOLOGY_FENCED, true);
      const placeholders = entities.map(() => "?").join(", ");
      if (this.storage.sql.exec(`SELECT 1 FROM entity_write_locks WHERE entity IN (${placeholders}) LIMIT 1`, ...entities).toArray().length)
        throw new OwnerWriteError(423, "entity is reserved by another transaction", true);
      let count = this.storage.sql.exec<{count: number}>("SELECT reservations AS count FROM tree_counts WHERE singleton = 1").one().count;
      if (count >= TREE_OUTCOME_LIMIT) {
        // Forget the oldest terminal outcomes past the guaranteed replay window.
        this.storage.sql.exec(`DELETE FROM tree_reservations WHERE tx_id IN (
          SELECT tx_id FROM tree_reservations WHERE phase IN ('complete', 'aborted') AND created_at_ms < ?
            AND tx_id NOT IN (SELECT tx_id FROM tree_publication_slots)
          ORDER BY created_at_ms LIMIT ?)`, now - MIN_IDEMPOTENCY_RETENTION_MS, OUTCOME_EVICTION_BATCH);
        count = this.storage.sql.exec<{count: number}>("SELECT reservations AS count FROM tree_counts WHERE singleton = 1").one().count;
      }
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
      return {reservationTicket: ticket, directoryEpoch: state.directory_epoch, fresh: true};
    });
  }

  /**
   * Hands this reservation the next publication revision. Many writers hold
   * revisions at once; `held` keeps a distributed write's revision out of the
   * graph's safe vector until it releases it.
   */
  acquirePublicationGate(txId: string, hash: string, ticket: number, epoch: number, identityTime: number, held = true): OwnerPublicationGate {
    return this.storage.transactionSync(() => {
      const row = this.read(txId);
      if (!row || row.payload_hash !== hash || row.ticket_seq !== ticket || row.created_at_ms !== identityTime)
        throw new OwnerWriteError(409, "publication gate does not match its reservation");
      const existing = this.readSlot(txId);
      if (existing) {
        if (existing.payload_hash === hash && existing.reservation_ticket === ticket &&
            existing.directory_epoch === epoch && existing.created_at_ms === identityTime) {
          return {reservationTicket: ticket, publicationSeq: existing.publication_seq, directoryEpoch: epoch};
        }
        throw new OwnerWriteError(409, "publication slot identity conflict");
      }
      if (row.phase !== "preparing" || row.directory_epoch !== epoch || epoch !== this.state().directory_epoch)
        throw new OwnerWriteError(409, "publication gate lost its owner reservation");
      this.assertOwnedSet(row, txId, hash);
      // One distributed write publishes on an owner at a time: its revisions
      // reach the safe vector together, so no later revision may get there
      // first. Writers take owners in prefix order, so they cannot deadlock.
      if (held && this.storage.sql.exec("SELECT 1 FROM tree_publication_slots WHERE held = 1 LIMIT 1").toArray().length > 0)
        throw new OwnerWriteError(423, "another transaction owns the publication gate", true);
      return {reservationTicket: ticket, publicationSeq: this.openSlot(txId, hash, ticket, epoch, identityTime, held), directoryEpoch: epoch};
    });
  }

  private openSlot(txId: string, hash: string, ticket: number, epoch: number, identityTime: number, held: boolean): number {
    const slots = this.storage.sql.exec<{open: number; highest: number | null}>(
      "SELECT COUNT(*) AS open, MAX(publication_seq) AS highest FROM tree_publication_slots").one();
    if (slots.open >= MAX_OPEN_PUBLICATION_SLOTS) throw new OwnerWriteError(423, "too many publications are in flight on this owner", true);
    const publicationSeq = Math.max(this.state().visible_seq, slots.highest ?? 0) + 1;
    if (!Number.isSafeInteger(publicationSeq) || publicationSeq >= Number.MAX_SAFE_INTEGER)
      throw new OwnerWriteError(429, "owner publication revision space is exhausted");
    this.storage.sql.exec(`INSERT INTO tree_publication_slots
      (tx_id, payload_hash, reservation_ticket, publication_seq, directory_epoch, created_at_ms, state, held)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`, txId, hash, ticket, publicationSeq, epoch, identityTime, held ? 1 : 0);
    return publicationSeq;
  }

  /** Where publication stands now. */
  frontier(): OwnerFrontier {
    const state = this.state();
    const held = this.storage.sql.exec<{seq: number | null}>(
      "SELECT MIN(publication_seq) AS seq FROM tree_publication_slots WHERE held = 1").one().seq;
    return {visibleSeq: state.visible_seq, publishableSeq: held === null ? state.visible_seq : Math.min(state.visible_seq, held - 1),
      directoryEpoch: state.directory_epoch};
  }

  release(txId: string, hash: string, identityTime: number, abort: boolean): void {
    this.storage.transactionSync(() => {
      const row = this.read(txId);
      if (!row) return;
      if (row.payload_hash !== hash || row.created_at_ms !== identityTime) throw new OwnerWriteError(409, "owner release identity conflict");
      if (row.phase !== "preparing") return;
      this.assertOwnedSet(row, txId, hash);
      this.storage.sql.exec("DELETE FROM entity_write_locks WHERE tx_id = ? AND payload_hash = ?", txId, hash);
      // An abandoned revision publishes nothing; marking it done lets later ones become visible.
      const slotted = this.readSlot(txId) !== undefined;
      this.storage.sql.exec("UPDATE tree_publication_slots SET state = 'done', held = 0 WHERE tx_id = ? AND payload_hash = ?", txId, hash);
      // A reservation with a revision stays as its record until the owner passes that revision.
      if (abort || slotted) this.storage.sql.exec("UPDATE tree_reservations SET phase = 'aborted' WHERE tx_id = ?", txId);
      else this.storage.sql.exec("DELETE FROM tree_reservations WHERE tx_id = ?", txId);
      this.advance();
    });
  }

  /**
   * Single-owner writes take their publication revision with the lock, in one
   * call. The revision is not held: nothing else must become visible with it.
   */
  reserveAndGate(txId: string, hash: string, entities: readonly Uri[], epoch: number, identityTime: number):
    OwnerReservationTicket & Readonly<{publicationSeq: number}> {
    return this.storage.transactionSync(() => {
      const {fresh, ...ticket} = this.reserve(txId, hash, entities, epoch, identityTime);
      // A reservation made in this same transaction needs no re-validation.
      const publicationSeq = fresh ? this.openSlot(txId, hash, ticket.reservationTicket, ticket.directoryEpoch, identityTime, false)
        : this.acquirePublicationGate(txId, hash, ticket.reservationTicket, ticket.directoryEpoch, identityTime, false).publicationSeq;
      return {...ticket, publicationSeq};
    });
  }

  /** Marks the write applied at its revision; the owner's visible revision advances over finished ones. */
  publish(txId: string, hash: string, ticket: number, publicationSeq: number, identityTime: number): void {
    this.storage.transactionSync(() => {
      const row = this.read(txId);
      if (!row || row.payload_hash !== hash || row.ticket_seq !== ticket || row.created_at_ms !== identityTime)
        throw new OwnerWriteError(409, "owner publication does not match its reservation");
      if (row.phase === "complete") {
        if (row.commit_seq !== publicationSeq) throw new OwnerWriteError(409, "owner publication revision changed on retry");
        return;
      }
      const slot = this.readSlot(txId);
      if (!slot || slot.payload_hash !== hash || slot.reservation_ticket !== ticket || slot.publication_seq !== publicationSeq ||
          slot.directory_epoch !== row.directory_epoch || slot.created_at_ms !== identityTime || slot.state !== "open")
        throw new OwnerWriteError(409, "owner publication gate is missing or changed");
      if (row.phase !== "preparing" || row.directory_epoch !== this.state().directory_epoch)
        throw new OwnerWriteError(409, "owner publication lost its ordered revision");
      // Releasing the locks proves they were all still held: the count must match.
      const released = this.storage.sql.exec("DELETE FROM entity_write_locks WHERE tx_id = ? AND payload_hash = ? RETURNING entity", txId, hash).toArray().length;
      if (released !== (JSON.parse(row.entities_json) as unknown[]).length) throw new OwnerWriteError(409, "owner lock membership changed");
      this.storage.sql.exec("UPDATE tree_reservations SET phase = 'complete', commit_seq = ? WHERE tx_id = ?", publicationSeq, txId);
      this.storage.sql.exec("UPDATE tree_publication_slots SET state = 'done' WHERE tx_id = ?", txId);
      this.advance();
    });
  }

  /** A distributed write lets its revision into the graph's safe vector once it has published there. */
  releasePublicationGate(txId: string, hash: string, ticket: number, publicationSeq: number, identityTime: number): void {
    this.storage.transactionSync(() => {
      const slot = this.readSlot(txId);
      const row = this.read(txId);
      if (!slot) {
        if (row?.payload_hash === hash && row.created_at_ms === identityTime &&
            (row.phase === "complete" || row.phase === "aborted")) return;
        if (!row) return;
        throw new OwnerWriteError(409, "publication gate is not owned by this terminal transaction");
      }
      if (slot.payload_hash !== hash || slot.reservation_ticket !== ticket ||
          slot.publication_seq !== publicationSeq || slot.created_at_ms !== identityTime)
        throw new OwnerWriteError(409, "publication gate release identity conflict");
      if (!row || row.phase !== "complete" && row.phase !== "aborted")
        throw new OwnerWriteError(409, "cannot release an unresolved publication gate");
      if (row.phase === "complete" && row.commit_seq !== publicationSeq)
        throw new OwnerWriteError(409, "publication gate release sequence mismatch");
      this.storage.sql.exec("UPDATE tree_publication_slots SET held = 0 WHERE tx_id = ?", txId);
      this.advance();
    });
  }

  /**
   * Advances the visible revision over the contiguous prefix of finished
   * revisions, and forgets finished, released revisions it has passed.
   */
  private advance(): void {
    const state = this.state();
    let visible = state.visible_seq;
    for (;;) {
      const next = this.storage.sql.exec<{state: string}>("SELECT state FROM tree_publication_slots WHERE publication_seq = ?", visible + 1).toArray()[0];
      if (next?.state !== "done") break;
      visible++;
    }
    if (visible !== state.visible_seq) this.storage.sql.exec("UPDATE graph_state SET visible_seq = ? WHERE singleton = 1", visible);
    this.storage.sql.exec("DELETE FROM tree_publication_slots WHERE state = 'done' AND held = 0 AND publication_seq <= ?", visible);
  }

  authorityReleased(txId: string, hash: string, seq: number, epoch: number, identityTime: number, decision: "committed" | "aborted"): boolean {
    const row = this.read(txId);
    // Replacement itself is a terminal-predecessor witness, not a watermark.
    // New identity locks must not prevent finalizing an old pin and deadlock
    // reuse of that ID at its leaf. Pending reservations are never replaced.
    if (row && row.created_at_ms > identityTime && identityTime < Date.now() - TRANSACTION_IDEMPOTENCY_RETENTION_MS) return true;
    const locks = this.storage.sql.exec("SELECT 1 FROM entity_write_locks WHERE tx_id = ? LIMIT 1", txId).toArray();
    const slot = this.readSlot(txId);
    if (locks.length || slot !== undefined) return false;
    // Only terminal records are pruned; this inference depends on that invariant.
    if (!row) return true;
    return row.payload_hash === hash && row.created_at_ms === identityTime && row.directory_epoch === epoch &&
      row.phase === (decision === "committed" ? "complete" : "aborted") &&
      (decision === "aborted" || row.commit_seq === seq);
  }

  audit(): Readonly<{entityLockCount: number; publicationGateCount: number; ownerTicketAnomalies: number}> {
    const entityLockCount = this.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM entity_write_locks").one().count;
    const publicationGateCount = this.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM tree_publication_slots").one().count;
    const invalidLocks = this.storage.sql.exec<{count: number}>(`SELECT COUNT(*) AS count FROM entity_write_locks l
      LEFT JOIN tree_reservations r ON r.tx_id = l.tx_id AND r.payload_hash = l.payload_hash
      WHERE r.tx_id IS NULL OR r.phase != 'preparing'
        OR NOT EXISTS (SELECT 1 FROM json_each(r.entities_json) e WHERE e.value = l.entity)`).one().count;
    const invalidTickets = this.storage.sql.exec<{count: number}>(`SELECT COUNT(*) AS count FROM tree_reservations r, graph_state s
      WHERE r.ticket_seq > s.next_write_seq
        OR (r.phase = 'complete' AND (r.commit_seq < 1 OR r.commit_seq > (SELECT MAX(s.visible_seq, COALESCE((SELECT MAX(publication_seq) FROM tree_publication_slots), 0)))))
        OR (r.phase = 'preparing' AND (SELECT COUNT(*) FROM entity_write_locks l WHERE l.tx_id = r.tx_id) != json_array_length(r.entities_json))`).one().count;
    const invalidGates = this.storage.sql.exec<{count: number}>(`SELECT COUNT(*) AS count FROM tree_publication_slots g
      LEFT JOIN tree_reservations r ON r.tx_id = g.tx_id AND r.payload_hash = g.payload_hash
      WHERE r.tx_id IS NULL OR r.ticket_seq != g.reservation_ticket OR r.directory_epoch != g.directory_epoch
        OR (g.state = 'open' AND r.phase != 'preparing')
        OR (g.state = 'done' AND r.phase = 'preparing')
        OR (r.phase = 'complete' AND r.commit_seq != g.publication_seq)
        OR (g.state = 'open' AND g.publication_seq <= (SELECT visible_seq FROM graph_state WHERE singleton = 1))`).one().count;
    return {entityLockCount, publicationGateCount, ownerTicketAnomalies: invalidLocks + invalidTickets + invalidGates};
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
  private readSlot(txId: string): PublicationSlot | undefined {
    return this.storage.sql.exec<PublicationSlot>("SELECT * FROM tree_publication_slots WHERE tx_id = ?", txId).toArray()[0];
  }
}
