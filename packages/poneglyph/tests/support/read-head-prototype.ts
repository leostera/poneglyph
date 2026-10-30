import {runInDurableObject} from "cloudflare:test";
import type {GraphId} from "../../src/domain/graph-id.js";
import {
  createReadHeadParent, parseReadHeadParent, type ReadHeadParent,
} from "../../src/storage/read-head-parent.js";
import {
  EMPTY_READ_HEAD, applyReadHeadCommand, parseReadHeadState, parseReadHeadView, readHeadViewsEqual,
  type ReadHeadCommand, type ReadHeadState, type ReadHeadTransition, type ReadHeadView,
} from "../../src/storage/read-head-state.js";

type Table = "test_read_head_parent" | "test_read_head_state";
type Row = {state_json: string};
export type ParentFault = "none" | "before-journal" | "after-commit";

// Test-only adapters. The production facade schema and entrypoint are unchanged.
// Existing local test namespaces provide real SQLite and eviction, NOT a new
// deployed role, publication hook, background alarm or public routing surface.
function ensureTable(storage: DurableObjectStorage, table: Table): void {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), state_json TEXT NOT NULL)`);
}
function readCheckpoint(storage: DurableObjectStorage, table: Table): unknown {
  const row = storage.sql.exec<Row>(`SELECT state_json FROM ${table} WHERE singleton = 1`).toArray()[0];
  return row === undefined ? undefined : JSON.parse(row.state_json);
}
function writeCheckpoint(storage: DurableObjectStorage, table: Table, state: ReadHeadParent | ReadHeadState): void {
  storage.sql.exec(`INSERT INTO ${table} (singleton, state_json) VALUES (1, ?)
    ON CONFLICT(singleton) DO UPDATE SET state_json = excluded.state_json`, JSON.stringify(state));
}
function writeCanonicalCut(storage: DurableObjectStorage, view: ReadHeadView): void {
  for (const owner of view.vector) storage.sql.exec(
    "UPDATE graph_safe_vector SET visible_seq = ?, directory_epoch = ? WHERE prefix = ?",
    owner.snapshotSeq, owner.directoryEpoch, owner.prefix);
  storage.sql.exec("UPDATE graph_safe_frontier SET frontier = ? WHERE singleton = 1", view.frontier);
}
function readParent(storage: DurableObjectStorage): ReadHeadParent {
  const parent = parseReadHeadParent(readCheckpoint(storage, "test_read_head_parent"));
  const frontier = storage.sql.exec<{frontier: number}>("SELECT frontier FROM graph_safe_frontier WHERE singleton = 1").one().frontier;
  const vector = storage.sql.exec<{prefix: string; visible_seq: number; directory_epoch: number}>(
    "SELECT prefix, visible_seq, directory_epoch FROM graph_safe_vector ORDER BY prefix").toArray();
  const canonical = parseReadHeadView({frontier, vector: vector.map(owner => ({
    prefix: owner.prefix, snapshotSeq: owner.visible_seq, directoryEpoch: owner.directory_epoch,
  }))});
  if (!readHeadViewsEqual(parent.view, canonical)) throw new Error("Test parent journal disagrees with canonical cut");
  return parent;
}
export async function initializeReadHeadParentPrototype(stub: DurableObjectStub, graphId: GraphId, view: ReadHeadView): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.transactionSync(() => {
      ensureTable(state.storage, "test_read_head_parent");
      if (readCheckpoint(state.storage, "test_read_head_parent") !== undefined) throw new Error("Test parent already exists");
      writeCanonicalCut(state.storage, view);
      writeCheckpoint(state.storage, "test_read_head_parent", createReadHeadParent(graphId, view));
    });
  });
}
export async function readParentPrototype(stub: DurableObjectStub): Promise<ReadHeadParent> {
  return runInDurableObject(stub, (_instance, state) => readParent(state.storage));
}
export async function mutateParentPrototype(
  stub: DurableObjectStub, advance: (parent: ReadHeadParent) => ReadHeadParent, fault: ParentFault = "none",
): Promise<ReadHeadParent> {
  return runInDurableObject(stub, (_instance, state) => {
    const next = state.storage.transactionSync(() => {
      const next = advance(readParent(state.storage));
      writeCanonicalCut(state.storage, next.view);
      if (fault === "before-journal") throw new Error("Test fault before journal persistence");
      writeCheckpoint(state.storage, "test_read_head_parent", next);
      return next;
    });
    // Simulate a lost reply AFTER storage committed, not a rolled-back command.
    if (fault === "after-commit") throw new Error("Test lost parent acknowledgement");
    return next;
  });
}
export async function readHeadPrototype(stub: DurableObjectStub): Promise<ReadHeadState> {
  return runInDurableObject(stub, (_instance, state) => {
    ensureTable(state.storage, "test_read_head_state");
    const raw = readCheckpoint(state.storage, "test_read_head_state");
    return raw === undefined ? EMPTY_READ_HEAD : parseReadHeadState(raw);
  });
}
export async function applyHeadPrototype(
  stub: DurableObjectStub, command: ReadHeadCommand, loseReply = false,
): Promise<ReadHeadTransition> {
  return runInDurableObject(stub, (_instance, state) => {
    const result = state.storage.transactionSync(() => {
      ensureTable(state.storage, "test_read_head_state");
      const raw = readCheckpoint(state.storage, "test_read_head_state");
      const previous = raw === undefined ? EMPTY_READ_HEAD : parseReadHeadState(raw);
      const result = applyReadHeadCommand(previous, command);
      if (result.outcome === "applied") writeCheckpoint(state.storage, "test_read_head_state", result.state);
      return result;
    });
    if (loseReply) throw new Error("Test lost head acknowledgement");
    return result;
  });
}
