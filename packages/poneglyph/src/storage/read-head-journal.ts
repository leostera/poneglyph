import type {GraphId} from "../domain/graph-id.js";
import {TREE_PREFIXES} from "./forest.js";
import type {VirtualPrefix} from "./keys.js";
import {
  acknowledgeReadHeadDelivery, beginReadHeadJoin, beginReadHeadPublication, beginReadHeadRetirement,
  createReadHeadParent, parseReadHeadParent, type ReadHeadDelivery, type ReadHeadParent,
} from "./read-head-parent.js";
import {parseReadHeadView, readHeadViewsEqual, type ReadHeadView} from "./read-head-state.js";

export const READ_HEAD_PARENT_KEY = "read-head-parent/v1";
export type ReadHeadPatch = Readonly<{kind: "owners"; owners: readonly Readonly<{
  prefix: VirtualPrefix; directoryEpoch: number; publicationSeq: number;
}>[]}> | Readonly<{kind: "topology"; prefix: VirtualPrefix; directoryEpoch: number; visibleSeq: number}>;
export class ReadHeadJournalError extends Error {
  constructor(readonly status: 409 | 423 | 429, message: string) { super(message); }
}
function busy(): never { throw new ReadHeadJournalError(423, "read-head coordination is pending"); }
function conflict(): never { throw new ReadHeadJournalError(409, "read-head request identity conflicts with durable state"); }
function facadeVersion(storage: DurableObjectStorage): number {
  const row = storage.sql.exec<{kind: string; version: number}>("SELECT kind, version FROM poneglyph_schema WHERE singleton = 1").one();
  if (row.kind !== "g-facade" || row.version !== 2 && row.version !== 3) throw new Error("Invalid read-head facade protocol fence");
  return row.version;
}
function canonicalView(storage: DurableObjectStorage): ReadHeadView {
  const frontier = storage.sql.exec<{frontier: number}>("SELECT frontier FROM graph_safe_frontier WHERE singleton = 1").one().frontier;
  const vector = storage.sql.exec<{prefix: string; visible_seq: number; directory_epoch: number}>(
    "SELECT prefix, visible_seq, directory_epoch FROM graph_safe_vector ORDER BY prefix").toArray();
  return parseReadHeadView({frontier, vector: vector.map(owner => ({
    prefix: owner.prefix, snapshotSeq: owner.visible_seq, directoryEpoch: owner.directory_epoch,
  }))});
}
function assertGraph(storage: DurableObjectStorage, graphId: GraphId): void {
  const row = storage.sql.exec<{graph_id: string}>("SELECT graph_id FROM graph_facade_identity WHERE singleton = 1").toArray()[0];
  if (row !== undefined && row.graph_id !== graphId) conflict();
  if (row === undefined) storage.sql.exec("INSERT INTO graph_facade_identity (singleton, graph_id) VALUES (1, ?)", graphId);
}
function patchedView(previous: ReadHeadView, patch: ReadHeadPatch): ReadHeadView {
  let changed = false;
  const vector = previous.vector.map(owner => {
    if (patch.kind === "owners") {
      const update = patch.owners.find(item => item.prefix === owner.prefix);
      if (update === undefined) return owner;
      if (update.directoryEpoch !== owner.directoryEpoch || update.publicationSeq < owner.snapshotSeq) conflict();
      changed ||= update.publicationSeq !== owner.snapshotSeq;
      return {prefix: owner.prefix, directoryEpoch: owner.directoryEpoch, snapshotSeq: update.publicationSeq};
    }
    if (patch.prefix !== owner.prefix) return owner;
    if (patch.directoryEpoch < owner.directoryEpoch || patch.visibleSeq < owner.snapshotSeq) conflict();
    changed ||= patch.directoryEpoch !== owner.directoryEpoch || patch.visibleSeq !== owner.snapshotSeq;
    return {prefix: owner.prefix, directoryEpoch: patch.directoryEpoch, snapshotSeq: patch.visibleSeq};
  });
  if (!changed) return previous;
  if (previous.frontier >= Number.MAX_SAFE_INTEGER) throw new ReadHeadJournalError(429, "cluster safe frontier space is exhausted");
  return parseReadHeadView({frontier: previous.frontier + 1, vector});
}

/** Owns BOTH the durable journal and its canonical-vector mirror. No I/O here. */
export class ReadHeadJournal {
  private parent: ReadHeadParent | null;
  constructor(private readonly storage: DurableObjectStorage, private readonly invalidate: () => void) {
    const raw: unknown = storage.kv.get(READ_HEAD_PARENT_KEY), version = facadeVersion(storage);
    if (version === 2) {
      if (raw !== undefined) throw new Error("Read-head journal is missing its old-writer fence");
      this.parent = null;
      return;
    }
    const parent = parseReadHeadParent(raw);
    const graph = storage.sql.exec<{graph_id: string}>("SELECT graph_id FROM graph_facade_identity WHERE singleton = 1").toArray()[0];
    if (graph?.graph_id !== parent.graphId || !readHeadViewsEqual(parent.view, canonicalView(storage))) {
      throw new Error("Read-head journal disagrees with canonical graph state");
    }
    this.parent = parent;
  }
  get state(): ReadHeadParent | null { return this.parent; }
  get enabled(): boolean { return this.parent !== null; }
  private bound(graphId: GraphId): ReadHeadParent {
    if (this.parent === null || this.parent.graphId !== graphId) conflict();
    return this.parent;
  }
  private commit(next: ReadHeadParent, enabling = false): void {
    const previous = this.parent;
    this.storage.transactionSync(() => {
      assertGraph(this.storage, next.graphId);
      if (enabling) {
        if (facadeVersion(this.storage) !== 2 || previous !== null) conflict();
        // Explicit per-graph migration: only the marker changes. No source data
        // is deleted/reinterpreted. Old binaries reject 3 before serving/writing.
        this.storage.sql.exec("UPDATE poneglyph_schema SET version = 3 WHERE singleton = 1 AND kind = 'g-facade'");
      }
      if (previous !== null && !readHeadViewsEqual(previous.view, next.view)) {
        this.invalidate(); // Also safe if the transaction subsequently rolls back.
        for (const owner of next.view.vector) this.storage.sql.exec(
          "UPDATE graph_safe_vector SET visible_seq = ?, directory_epoch = ? WHERE prefix = ?",
          owner.snapshotSeq, owner.directoryEpoch, owner.prefix);
        this.storage.sql.exec("UPDATE graph_safe_frontier SET frontier = ? WHERE singleton = 1", next.view.frontier);
      }
      this.storage.kv.put(READ_HEAD_PARENT_KEY, next);
    });
    this.parent = next; // Persist first, mirror second.
  }
  join(graphId: GraphId, expectedGeneration: number): number {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) conflict();
    if (expectedGeneration >= Number.MAX_SAFE_INTEGER) throw new ReadHeadJournalError(429, "read-head generation space is exhausted");
    const member = expectedGeneration + 1;
    if (this.parent === null) {
      if (expectedGeneration !== 0) conflict();
      // Called only by the explicit private join path, never on startup or read.
      const initial = createReadHeadParent(graphId, canonicalView(this.storage));
      this.commit(beginReadHeadJoin(initial), true);
      return member;
    }
    const parent = this.bound(graphId);
    if (parent.members.includes(member) || parent.generation === member && parent.operation?.kind === "join") return member;
    if (parent.generation !== expectedGeneration) conflict();
    if (parent.operation !== null) busy();
    this.commit(beginReadHeadJoin(parent));
    return member;
  }
  retire(graphId: GraphId, member: number, expectedGeneration: number): void {
    const parent = this.bound(graphId);
    if (!Number.isSafeInteger(member) || member < 1 || member > expectedGeneration ||
        !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) conflict();
    if (!parent.members.includes(member)) {
      if (parent.generation <= expectedGeneration) conflict();
      return; // An allocated identity is never reused or reactivated.
    }
    if (parent.operation?.kind === "retire" && parent.operation.member === member && parent.generation === expectedGeneration + 1) return;
    if (parent.generation !== expectedGeneration) conflict();
    if (parent.operation !== null) busy();
    if (parent.generation >= Number.MAX_SAFE_INTEGER) throw new ReadHeadJournalError(429, "read-head generation space is exhausted");
    this.commit(beginReadHeadRetirement(parent, member));
  }
  publish(graphId: GraphId, patch: ReadHeadPatch): void {
    const parent = this.bound(graphId);
    if (patch.kind === "owners" && (patch.owners.length === 0 || patch.owners.some(owner => !TREE_PREFIXES.includes(owner.prefix)) ||
        new Set(patch.owners.map(owner => owner.prefix)).size !== patch.owners.length)) conflict();
    if (patch.kind === "topology" && !TREE_PREFIXES.includes(patch.prefix)) conflict();
    const operation = parent.operation;
    if (operation !== null) {
      if (operation.kind !== "publication") busy();
      // Reconcile the same owner/epoch publication against its ORIGINAL cut,
      // including after canonical commit but before all activation replies.
      if (!readHeadViewsEqual(patchedView(operation.previousView, patch), operation.nextView)) busy();
      return;
    }
    const next = patchedView(parent.view, patch);
    if (next === parent.view) return;
    if (parent.generation >= Number.MAX_SAFE_INTEGER) throw new ReadHeadJournalError(429, "read-head generation space is exhausted");
    this.commit(beginReadHeadPublication(parent, next));
  }
  acknowledge(delivery: ReadHeadDelivery, outcome: unknown): void {
    if (this.parent === null) conflict();
    const next = acknowledgeReadHeadDelivery(this.parent, delivery, outcome);
    if (next !== this.parent) this.commit(next);
  }
}
