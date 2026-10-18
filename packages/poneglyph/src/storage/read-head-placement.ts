import {parseGraphId, type GraphId} from "../domain/graph-id.js";
import {ROUTING_VERSION} from "./constants.js";
import {isRecord} from "../domain/result.js";

export const READ_HEAD_IDENTITY_KEY = "read-head-identity/v1";
export const READ_HEAD_STATE_KEY = "read-head-state/v1";
export type ReadHeadReplicaIdentity = Readonly<{graphId: GraphId; member: number}>;

/** A new metadata-only instance, never the canonical facade for this graph. */
export function readHeadReplicaName(graphId: GraphId, member: number): string {
  if (!Number.isSafeInteger(member) || member < 1) throw new Error("Invalid read-head member identity");
  return `graph:${graphId}:read-head:v${ROUTING_VERSION}:${member}`;
}

/** Reserved malformed roles fail closed instead of becoming canonical facades. */
export function parseReadHeadReplicaName(name: string | undefined): ReadHeadReplicaIdentity | null {
  if (name === undefined || !/^graph:[^:]+:read-head:/.test(name)) return null;
  const matched = /^graph:([^:]+):read-head:v([0-9]+):([0-9]+)$/.exec(name);
  if (matched === null) throw new Error("Invalid read-head object identity");
  const graph = parseGraphId(matched[1]), member = Number(matched[3]);
  if (!graph.ok || !Number.isSafeInteger(member) || member < 1 || readHeadReplicaName(graph.value, member) !== name) {
    throw new Error("Invalid read-head object identity");
  }
  return Object.freeze({graphId: graph.value, member});
}

function parseStoredIdentity(raw: unknown): ReadHeadReplicaIdentity {
  if (!isRecord(raw) || Object.keys(raw).length !== 2 || !Object.hasOwn(raw, "graphId") || !Object.hasOwn(raw, "member")) {
    throw new Error("Invalid durable read-head identity");
  }
  const graph = parseGraphId(raw["graphId"]), member = raw["member"];
  if (!graph.ok || typeof member !== "number" || !Number.isSafeInteger(member) || member < 1) {
    throw new Error("Invalid durable read-head identity");
  }
  return Object.freeze({graphId: graph.value, member});
}

/** Keep the role durable: idFromString() does not supply ctx.id.name on restart. */
export function resolveReadHeadReplicaIdentity(ctx: Pick<DurableObjectState, "id" | "storage">): ReadHeadReplicaIdentity | null {
  const named = parseReadHeadReplicaName(ctx.id.name);
  const raw: unknown = ctx.storage.kv.get(READ_HEAD_IDENTITY_KEY);
  const stored = raw === undefined ? null : parseStoredIdentity(raw);
  if (stored !== null) {
    if (ctx.id.name !== undefined && ctx.id.name !== readHeadReplicaName(stored.graphId, stored.member)) {
      throw new Error("Read-head durable/physical identity mismatch");
    }
    return stored;
  }
  if (ctx.storage.kv.get(READ_HEAD_STATE_KEY) !== undefined) throw new Error("Read-head state has no durable role identity");
  if (named === null) return null;
  // Never reinterpret an already-bound canonical facade as a metadata role.
  const existing = ctx.storage.sql.exec("SELECT graph_id FROM graph_facade_identity WHERE singleton = 1").toArray();
  if (existing.length !== 0) throw new Error("Canonical facade cannot become a read head");
  ctx.storage.kv.put(READ_HEAD_IDENTITY_KEY, named);
  return named;
}
