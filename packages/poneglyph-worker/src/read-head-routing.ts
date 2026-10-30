import type {GraphId} from "../../poneglyph/src/domain/graph-id.js";
import {isRecord} from "../../poneglyph/src/domain/result.js";
import type {StorageEnv} from "../../poneglyph/src/storage/environment.js";
import {readJsonBody} from "../../poneglyph/src/storage/http.js";
import {coordinatorObjectName} from "../../poneglyph/src/storage/keys.js";
import {MAX_READ_HEAD_DISCOVERY_MEMBERS, readHeadReplicaName} from "../../poneglyph/src/storage/read-head-placement.js";
import type {ReadIdentity} from "../../poneglyph/src/storage/read-identity.js";
import {BoundedReadCache, utf8Bytes} from "../../poneglyph/src/storage/read-cache.js";

// Routing budgets, never read-authority leases or active-read admission limits.
const DISCOVERY_REFRESH_MS = 30_000;
const DISCOVERY_BACKOFF_MS = 1_000;
const HEAD_REQUEST_TIMEOUT_MS = 250;
const ENVELOPE_BYTES = 16_384;
type RoutingHint = Readonly<{members: readonly number[]; refreshAtMs: number}>;
export type ReadHeadValidation =
  | Readonly<{kind: "unchanged"}>
  | Readonly<{kind: "canonical"; reason: "not-selected" | "changed" | "unavailable" | "protocol" | "budget"}>;

function counter(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0;
}

/** Parse a bounded routing hint, not permission or snapshot authority. */
export function parseReadHeadDiscovery(input: unknown): readonly number[] {
  if (!isRecord(input) || Object.keys(input).length !== 3 ||
      !["enabled", "generation", "members"].every(key => Object.hasOwn(input, key)) ||
      typeof input["enabled"] !== "boolean" || !counter(input["generation"]) ||
      !Array.isArray(input["members"]) || input["members"].length > MAX_READ_HEAD_DISCOVERY_MEMBERS) {
    throw new Error("Invalid read-head discovery");
  }
  const members: number[] = [];
  for (const member of input["members"]) {
    if (!counter(member) || member < 1 || member > input["generation"] || members.includes(member)) {
      throw new Error("Invalid read-head member");
    }
    members.push(member);
  }
  if (!input["enabled"] && (input["generation"] !== 0 || members.length !== 0)) {
    throw new Error("Disabled read-head discovery has members");
  }
  return Object.freeze(members);
}

/** Each invocation owns and settles its own I/O, including cancellation. */
async function requestJson(env: StorageEnv, name: string, path: string, body: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEAD_REQUEST_TIMEOUT_MS);
  try {
    const response = await env.GRAPH_FACADES.getByName(name).fetch(`https://head.internal${path}`, {
      method: "POST", headers: {"content-type": "application/json"}, body, signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Read-head routing is unavailable");
    }
    const parsed = await readJsonBody(response, ENVELOPE_BYTES);
    if (!parsed.ok) throw new Error("Invalid read-head routing response");
    return parsed.value;
  } finally { clearTimeout(timer); }
}

/**
 * Cache completed immutable membership hints ONLY. A stale hint can choose a
 * retired/unavailable head, never authorize stale data: every hit still needs
 * that head's fresh, exact validation. The caller falls back to canonical on
 * every other outcome. Cold reads and scans retain their canonical lease path.
 */
export class ReadHeadRouter {
  private readonly hints = new BoundedReadCache<RoutingHint>(128, 128_000);
  constructor(private readonly now: () => number = Date.now, private readonly sample: () => number = Math.random) {}

  private remember(graphId: GraphId, members: readonly number[], refreshAtMs: number): void {
    const hint = Object.freeze({members, refreshAtMs});
    this.hints.set(graphId, hint, utf8Bytes(JSON.stringify(hint)));
  }

  private async members(env: StorageEnv, graphId: GraphId): Promise<readonly number[]> {
    const previous = this.hints.get(graphId), now = this.now();
    if (previous !== undefined && now < previous.refreshAtMs) return previous.members;
    // Reserve a short discovery interval BEFORE awaiting. Concurrent requests
    // keep using completed hints or canonical authority, not another request's
    // promise/stream/stub. This is discovery throttling, not read rejection.
    this.remember(graphId, previous?.members ?? Object.freeze([]), now + DISCOVERY_BACKOFF_MS);
    try {
      const discovered = parseReadHeadDiscovery(await requestJson(env, coordinatorObjectName(graphId),
        "/_read-head-discover", JSON.stringify({graphId})));
      this.remember(graphId, discovered, this.now() + (discovered.length === 0 ? DISCOVERY_BACKOFF_MS : DISCOVERY_REFRESH_MS));
      return discovered;
    } catch {
      // Membership is only a hint. A failed refresh does not invalidate a
      // still-serving head's ability to provide a fresh validation itself.
      return previous?.members ?? [];
    }
  }

  async validate(env: StorageEnv, graphId: GraphId, query: string, identity: ReadIdentity): Promise<ReadHeadValidation> {
    const members = await this.members(env, graphId);
    if (members.length === 0) return {kind: "canonical", reason: "not-selected"};
    const member = members[Math.floor(this.sample() * members.length)];
    if (member === undefined) return {kind: "canonical", reason: "not-selected"};
    const body = JSON.stringify({graphId, member, query, knownSnapshot: identity});
    if (utf8Bytes(body) > ENVELOPE_BYTES) return {kind: "canonical", reason: "budget"};
    let raw: unknown;
    try { raw = await requestJson(env, readHeadReplicaName(graphId, member), "/_read-head-validate", body); }
    catch (error) {
      console.error({event: "candidate-head-validation-unavailable", member,
        errorName: error instanceof Error ? error.name : "unknown",
        errorMessage: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)});
      return {kind: "canonical", reason: "unavailable"};
    }
    if (isRecord(raw) && Object.keys(raw).length === 2 && Object.hasOwn(raw, "unchanged") && Object.hasOwn(raw, "snapshotSeq") && raw["unchanged"] === true &&
        raw["snapshotSeq"] === Math.max(...identity.map(owner => owner.snapshotSeq))) return {kind: "unchanged"};
    if (isRecord(raw) && Object.keys(raw).length === 1 && Object.hasOwn(raw, "canonical") && raw["canonical"] === true) return {kind: "canonical", reason: "changed"};
    return {kind: "canonical", reason: "protocol"};
  }
}

// No request-owned work or authority is kept here, only the router's bounded
// completed hints. Authorization remains ahead of executeWorkerQuery.
export const completedReadHeadRouter = new ReadHeadRouter();
