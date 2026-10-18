import {parseGraphId, type GraphId} from "../domain/graph-id.js";
import {isRecord} from "../domain/result.js";
import {TREE_PREFIXES} from "./forest.js";
import type {VirtualPrefix} from "./keys.js";
import {parseReadIdentity, type ReadIdentity} from "./read-identity.js";

/** Prototype metadata projection, not a new fact store or deployed DO class. */
declare const fullReadHeadView: unique symbol;
export type ReadHeadView = Readonly<{frontier: number; vector: ReadIdentity; [fullReadHeadView]: "full-read-head-view"}>;
type BoundHead = Readonly<{graphId: GraphId; generation: number}>;
export type ReadHeadState =
  | Readonly<{mode: "empty"}>
  | BoundHead & Readonly<{mode: "serving"; operation: "bootstrap" | "publication"; view: ReadHeadView}>
  | BoundHead & Readonly<{mode: "preparing"; view: ReadHeadView; nextView: ReadHeadView}>
  | BoundHead & Readonly<{mode: "frozen"; previousView: ReadHeadView | null; nextView: ReadHeadView}>
  | BoundHead & Readonly<{mode: "retired"}>;
export type ReadHeadCommand = BoundHead & (
  | Readonly<{kind: "bootstrap" | "prepare"; view: ReadHeadView}>
  | Readonly<{kind: "freeze" | "activate" | "retire"}>
);
export type ReadHeadTransition = Readonly<{
  outcome: "applied" | "already-applied" | "stale" | "conflict";
  state: ReadHeadState;
}>;
export const EMPTY_READ_HEAD: ReadHeadState = Object.freeze({mode: "empty"});

function counter(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0;
}
function keys(raw: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(raw).length === expected.length && expected.every(key => Object.hasOwn(raw, key));
}
function invalid(): never { throw new Error("Invalid read-head protocol value"); }

export function parseReadHeadView(raw: unknown): ReadHeadView {
  if (!isRecord(raw) || !keys(raw, ["frontier", "vector"]) || !counter(raw["frontier"])) return invalid();
  // The brand certifies full validated owner coverage, not canonical transaction
  // closure: only the parent's publication protocol can establish that closure.
  return Object.freeze({frontier: raw["frontier"], vector: parseReadIdentity(raw["vector"], TREE_PREFIXES)}) as ReadHeadView;
}

function sameView(left: ReadHeadView, right: ReadHeadView): boolean {
  return left.frontier === right.frontier && left.vector.every(owner => {
    const other = right.vector.find(candidate => candidate.prefix === owner.prefix);
    return other?.snapshotSeq === owner.snapshotSeq && other.directoryEpoch === owner.directoryEpoch;
  });
}

/** Publication frontier advances once; membership fencing generations need not. */
function nextView(previous: ReadHeadView, next: ReadHeadView): boolean {
  return next.frontier === previous.frontier + 1 && !sameComponents(previous, next) && previous.vector.every(owner => {
    const other = next.vector.find(candidate => candidate.prefix === owner.prefix);
    return other !== undefined && other.snapshotSeq >= owner.snapshotSeq && other.directoryEpoch >= owner.directoryEpoch;
  });
}
function sameComponents(left: ReadHeadView, right: ReadHeadView): boolean {
  return left.vector.every(owner => right.vector.some(other => other.prefix === owner.prefix &&
    other.snapshotSeq === owner.snapshotSeq && other.directoryEpoch === owner.directoryEpoch));
}

export function parseReadHeadCommand(raw: unknown): ReadHeadCommand {
  if (!isRecord(raw) || !counter(raw["generation"])) return invalid();
  const graph = parseGraphId(raw["graphId"]);
  if (!graph.ok) return invalid();
  const base = {graphId: graph.value, generation: raw["generation"]};
  const kind = raw["kind"];
  if ((kind === "bootstrap" || kind === "prepare") && keys(raw, ["kind", "graphId", "generation", "view"])) {
    return Object.freeze({...base, kind, view: parseReadHeadView(raw["view"])});
  }
  if ((kind === "freeze" || kind === "activate" || kind === "retire") && keys(raw, ["kind", "graphId", "generation"])) {
    return Object.freeze({...base, kind});
  }
  return invalid();
}

/** Parse durable checkpoints too: malformed state never becomes serving state. */
export function parseReadHeadState(raw: unknown): ReadHeadState {
  if (!isRecord(raw)) return invalid();
  if (raw["mode"] === "empty" && keys(raw, ["mode"])) return EMPTY_READ_HEAD;
  if (!counter(raw["generation"])) return invalid();
  const graph = parseGraphId(raw["graphId"]);
  if (!graph.ok) return invalid();
  const base = {graphId: graph.value, generation: raw["generation"]};
  const mode = raw["mode"];
  if (mode === "retired" && keys(raw, ["mode", "graphId", "generation"])) return Object.freeze({...base, mode});
  if (mode === "serving" && keys(raw, ["mode", "graphId", "generation", "operation", "view"]) &&
      (raw["operation"] === "bootstrap" || raw["operation"] === "publication")) {
    return Object.freeze({...base, mode, operation: raw["operation"], view: parseReadHeadView(raw["view"])});
  }
  if (mode === "preparing" && keys(raw, ["mode", "graphId", "generation", "view", "nextView"])) {
    const view = parseReadHeadView(raw["view"]), next = parseReadHeadView(raw["nextView"]);
    if (!nextView(view, next)) return invalid();
    return Object.freeze({...base, mode, view, nextView: next});
  }
  if (mode === "frozen" && keys(raw, ["mode", "graphId", "generation", "previousView", "nextView"])) {
    const previous = raw["previousView"] === null ? null : parseReadHeadView(raw["previousView"]);
    const next = parseReadHeadView(raw["nextView"]);
    if (previous !== null && !nextView(previous, next)) return invalid();
    return Object.freeze({...base, mode, previousView: previous, nextView: next});
  }
  return invalid();
}

function transition(state: ReadHeadState, outcome: ReadHeadTransition["outcome"]): ReadHeadTransition {
  return Object.freeze({state, outcome});
}

function prepare(state: ReadHeadState, command: Extract<ReadHeadCommand, {kind: "bootstrap" | "prepare"}>): ReadHeadTransition {
  if (command.kind === "bootstrap") {
    if (state.mode === "empty") return transition(Object.freeze({mode: "frozen", graphId: command.graphId,
      generation: command.generation, previousView: null, nextView: command.view}), "applied");
    if (state.generation !== command.generation) return transition(state, "conflict");
    const installed = state.mode === "serving" && state.operation === "bootstrap" ? state.view :
      state.mode === "frozen" && state.previousView === null ? state.nextView : undefined;
    return transition(state, installed !== undefined && sameView(installed, command.view) ? "already-applied" : "conflict");
  }
  if (state.mode === "empty" || state.mode === "retired") return transition(state, "conflict");
  if (command.generation === state.generation) {
    if ((state.mode === "serving" && state.operation !== "publication") ||
        (state.mode === "frozen" && state.previousView === null)) {
      return transition(state, "conflict");
    }
    const installed = state.mode === "serving" ? state.view : state.nextView;
    return transition(state, sameView(installed, command.view) ? "already-applied" : "conflict");
  }
  if (state.mode !== "serving" || !nextView(state.view, command.view)) return transition(state, "conflict");
  return transition(Object.freeze({mode: "preparing", graphId: state.graphId, generation: command.generation,
    view: state.view, nextView: command.view}), "applied");
}

/**
 * Pure durable transition kernel. The parent must serialize membership/publication,
 * freeze EVERY registered head before canonical publication, and activate only
 * after that publication. A head cannot independently certify the parent's cut.
 * Never acknowledge an applied command until its returned state is durable.
 */
export function applyReadHeadCommand(state: ReadHeadState, command: ReadHeadCommand): ReadHeadTransition {
  if (state.mode !== "empty") {
    if (state.graphId !== command.graphId) return transition(state, "conflict");
    if (command.generation < state.generation) return transition(state, "stale");
  }
  if (command.kind === "prepare" || command.kind === "bootstrap") return prepare(state, command);
  if (command.kind === "retire") {
    if (state.mode !== "empty" && state.generation === command.generation) {
      return transition(state, state.mode === "retired" ? "already-applied" : "conflict");
    }
    return transition(Object.freeze({mode: "retired", graphId: command.graphId, generation: command.generation}), "applied");
  }
  if (state.mode === "empty" || state.mode === "retired" || state.generation !== command.generation) return transition(state, "conflict");
  if (command.kind === "freeze") {
    // Delayed duplicate freezes must not refreeze a view already activated.
    if (state.mode === "serving") return transition(state, state.operation === "publication" ? "already-applied" : "conflict");
    if (state.mode === "frozen") return transition(state, state.previousView !== null ? "already-applied" : "conflict");
    return transition(Object.freeze({mode: "frozen", graphId: state.graphId, generation: state.generation,
      previousView: state.view, nextView: state.nextView}), "applied");
  }
  if (state.mode === "serving") return transition(state, "already-applied");
  if (state.mode !== "frozen") return transition(state, "conflict");
  return transition(Object.freeze({mode: "serving", graphId: state.graphId, generation: state.generation,
    operation: state.previousView === null ? "bootstrap" : "publication", view: state.nextView}), "applied");
}

function matchesIdentity(view: ReadHeadView, identity: ReadIdentity): boolean {
  return identity.every(owner => view.vector.some(other => other.prefix === owner.prefix &&
    other.snapshotSeq === owner.snapshotSeq && other.directoryEpoch === owner.directoryEpoch));
}

/**
 * The caller derives expectedPrefixes from the QUERY, never from this hint.
 * Even a frozen head can validate an unchanged projection shared by both its
 * previous and next closed cuts. Changed projections must route to authority.
 * This checks completed rows only; it never grants leases for storage scans.
 */
export function validateCompletedReadHead(
  state: ReadHeadState, graphId: GraphId, expectedPrefixes: readonly VirtualPrefix[], rawIdentity: unknown,
): Readonly<{kind: "unchanged"; snapshotSeq: number}> | Readonly<{kind: "canonical"}> {
  if (expectedPrefixes.length === 0) return invalid();
  const identity = parseReadIdentity(rawIdentity, expectedPrefixes);
  const current = captureReadHeadView(state, graphId);
  const unchanged = current !== null ? matchesIdentity(current, identity) :
    state.mode === "frozen" && state.previousView !== null &&
    matchesIdentity(state.previousView, identity) && matchesIdentity(state.nextView, identity);
  return unchanged ? Object.freeze({kind: "unchanged", snapshotSeq: Math.max(...identity.map(owner => owner.snapshotSeq))}) :
    Object.freeze({kind: "canonical"});
}

/** A fresh RPC result, never a reusable time-based permission or read lease. */
export function captureReadHeadView(state: ReadHeadState, graphId: GraphId): ReadHeadView | null {
  if (state.mode === "empty") return null;
  if (state.graphId !== graphId) throw new Error("Read-head graph identity mismatch");
  return state.mode === "serving" || state.mode === "preparing" ? state.view : null;
}
