import {parseGraphId, type GraphId} from "../domain/graph-id.js";
import {isRecord} from "../domain/result.js";
import {
  isNextReadHeadView, parseReadHeadCommand, parseReadHeadView, readHeadViewsEqual,
  type ReadHeadCommand, type ReadHeadView,
} from "./read-head-state.js";

type Publication = Readonly<{
  kind: "publication"; phase: "prepare" | "freeze" | "activate";
  previousView: ReadHeadView; nextView: ReadHeadView; acknowledged: readonly number[];
}>;
type Membership = Readonly<{kind: "join"; phase: "bootstrap" | "activate"; member: number}> |
  Readonly<{kind: "retire"; member: number}>;
declare const parsedParent: unique symbol;
/** Inactive prototype. Only its journal owner may advance membership/publication. */
export type ReadHeadParent = Readonly<{
  graphId: GraphId; generation: number; view: ReadHeadView;
  // Member IDs are the JOIN's fencing generation, never a reusable slot number.
  members: readonly number[]; operation: Publication | Membership | null;
  [parsedParent]: "parsed-read-head-parent";
}>;
export type ReadHeadDelivery = Readonly<{member: number; command: ReadHeadCommand}>;

function invalid(): never { throw new Error("Invalid read-head parent journal"); }
function keys(raw: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(raw).length === expected.length && expected.every(key => Object.hasOwn(raw, key));
}
function counter(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0;
}
function members(raw: unknown, generation: number): readonly number[] {
  if (!Array.isArray(raw)) return invalid();
  const parsed = Array.from(raw, (item: unknown) => {
    if (!counter(item) || item < 1 || item > generation) return invalid();
    return item;
  });
  if (new Set(parsed).size !== parsed.length) return invalid();
  return Object.freeze(parsed.sort((a, b) => a - b));
}

function parseOperation(
  raw: unknown, generation: number, roster: readonly number[], current: ReadHeadView,
): Publication | Membership | null {
  if (raw === null) return null;
  if (!isRecord(raw) || generation === 0) return invalid();
  if (raw["kind"] === "retire" && keys(raw, ["kind", "member"]) &&
      counter(raw["member"]) && raw["member"] < generation && roster.includes(raw["member"])) {
    return Object.freeze({kind: "retire", member: raw["member"]});
  }
  if (raw["kind"] === "join" && keys(raw, ["kind", "phase", "member"]) && raw["member"] === generation) {
    const phase = raw["phase"];
    if ((phase === "bootstrap" && !roster.includes(generation)) || (phase === "activate" && roster.includes(generation))) {
      return Object.freeze({kind: "join", phase, member: generation});
    }
  }
  if (raw["kind"] !== "publication" || !keys(raw, ["kind", "phase", "previousView", "nextView", "acknowledged"])) return invalid();
  const phase = raw["phase"];
  if (phase !== "prepare" && phase !== "freeze" && phase !== "activate") return invalid();
  const previousView = parseReadHeadView(raw["previousView"]), nextView = parseReadHeadView(raw["nextView"]);
  const acknowledged = members(raw["acknowledged"], generation);
  if (!isNextReadHeadView(previousView, nextView) || roster.length === 0 || roster.some(member => member >= generation) ||
      acknowledged.length >= roster.length || acknowledged.some(member => !roster.includes(member)) ||
      !readHeadViewsEqual(current, phase === "activate" ? nextView : previousView)) return invalid();
  return Object.freeze({kind: "publication", phase, previousView, nextView, acknowledged});
}

/** Checkpoints carry the canonical cut AND pending work in one atomic record. */
export function parseReadHeadParent(raw: unknown): ReadHeadParent {
  if (!isRecord(raw) || !keys(raw, ["graphId", "generation", "view", "members", "operation"]) ||
      !counter(raw["generation"])) return invalid();
  const graph = parseGraphId(raw["graphId"]);
  if (!graph.ok) return invalid();
  const generation = raw["generation"], roster = members(raw["members"], generation), view = parseReadHeadView(raw["view"]);
  const operation = parseOperation(raw["operation"], generation, roster, view);
  return Object.freeze({graphId: graph.value, generation, view, members: roster, operation}) as ReadHeadParent;
}

export function createReadHeadParent(graphId: GraphId, view: ReadHeadView): ReadHeadParent {
  return parseReadHeadParent({graphId, generation: 0, view, members: [], operation: null});
}
function nextGeneration(parent: ReadHeadParent): number {
  if (parent.operation !== null) throw new Error("Read-head parent already has pending work");
  if (parent.generation >= Number.MAX_SAFE_INTEGER) throw new Error("Read-head fencing generation is exhausted");
  return parent.generation + 1;
}
export function beginReadHeadJoin(parent: ReadHeadParent): ReadHeadParent {
  const generation = nextGeneration(parent);
  return parseReadHeadParent({...parent, generation, operation: {kind: "join", phase: "bootstrap", member: generation}});
}
export function beginReadHeadRetirement(parent: ReadHeadParent, member: number): ReadHeadParent {
  const generation = nextGeneration(parent);
  if (!parent.members.includes(member)) throw new Error("Read-head member is not registered");
  return parseReadHeadParent({...parent, generation, operation: {kind: "retire", member}});
}
export function beginReadHeadPublication(parent: ReadHeadParent, nextView: ReadHeadView): ReadHeadParent {
  const generation = nextGeneration(parent);
  if (!isNextReadHeadView(parent.view, nextView)) throw new Error("Read-head publication must advance the closed cut");
  // No registered serving routes means no remote fence is needed.
  if (parent.members.length === 0) return parseReadHeadParent({...parent, generation, view: nextView});
  return parseReadHeadParent({...parent, generation, operation: {
    kind: "publication", phase: "prepare", previousView: parent.view, nextView, acknowledged: [],
  }});
}

/** Reconstruct EXACT pending commands from durable work; never retain RPC I/O. */
export function pendingReadHeadDeliveries(parent: ReadHeadParent): readonly ReadHeadDelivery[] {
  const operation = parent.operation;
  if (operation === null) return Object.freeze([]);
  const targets = operation.kind === "publication" ? parent.members.filter(member => !operation.acknowledged.includes(member)) : [operation.member];
  return Object.freeze(targets.map(member => {
    const kind = operation.kind === "join" ? operation.phase : operation.kind === "retire" ? "retire" : operation.phase;
    const view = kind === "bootstrap" ? parent.view : operation.kind === "publication" && kind === "prepare" ? operation.nextView : undefined;
    const command = parseReadHeadCommand({kind, graphId: parent.graphId, generation: parent.generation, ...(view ? {view} : {})});
    return Object.freeze({member, command});
  }));
}

function sameCommand(left: ReadHeadCommand, right: ReadHeadCommand): boolean {
  if (left.graphId !== right.graphId || left.generation !== right.generation || left.kind !== right.kind) return false;
  if (left.kind === "bootstrap" || left.kind === "prepare") {
    return (right.kind === "bootstrap" || right.kind === "prepare") && readHeadViewsEqual(left.view, right.view);
  }
  return true;
}
function acknowledgeMembership(parent: ReadHeadParent, operation: Membership): ReadHeadParent {
  if (operation.kind === "retire") return parseReadHeadParent({...parent,
    members: parent.members.filter(member => member !== operation.member), operation: null});
  if (operation.phase === "bootstrap") return parseReadHeadParent({...parent,
    members: [...parent.members, operation.member], operation: {...operation, phase: "activate"}});
  return parseReadHeadParent({...parent, operation: null});
}
function acknowledgePublication(parent: ReadHeadParent, operation: Publication, member: number): ReadHeadParent {
  const acknowledged = [...operation.acknowledged, member];
  if (acknowledged.length < parent.members.length) return parseReadHeadParent({...parent, operation: {...operation, acknowledged}});
  if (operation.phase === "activate") return parseReadHeadParent({...parent, operation: null});
  const phase = operation.phase === "prepare" ? "freeze" : "activate";
  // Canonical publication and activation intent MUST commit atomically. An
  // adapter to graph_safe_vector must include both in its SQLite transaction.
  return parseReadHeadParent({...parent, view: phase === "activate" ? operation.nextView : parent.view,
    operation: {...operation, phase, acknowledged: []}});
}

/**
 * Persist returned state before sending its pending commands or acknowledging a
 * write. Only a confirmed matching command may advance work. Lost replies leave
 * exact, idempotent work pending; stale replies cannot acknowledge a later phase.
 */
export function acknowledgeReadHeadDelivery(
  parent: ReadHeadParent, delivery: ReadHeadDelivery, outcome: unknown,
): ReadHeadParent {
  if (outcome !== "applied" && outcome !== "already-applied") return parent;
  const expected = pendingReadHeadDeliveries(parent).find(item => item.member === delivery.member && sameCommand(item.command, delivery.command));
  if (expected === undefined || parent.operation === null) return parent;
  return parent.operation.kind === "publication" ? acknowledgePublication(parent, parent.operation, delivery.member) :
    acknowledgeMembership(parent, parent.operation);
}
