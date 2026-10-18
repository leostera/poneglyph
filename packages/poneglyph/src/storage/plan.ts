import type { FactBatch } from "../domain/fact.js";
import { parseGraphId } from "../domain/graph-id.js";
import { parseUri, type Uri } from "../domain/identifiers.js";
import { isRecord } from "../domain/result.js";
import { MAX_TRANSACTION_PARTICIPANTS } from "./constants.js";
import { TREE_DEPTH, treeForKey } from "./forest.js";
import { parseVirtualKey, parseVirtualPrefix, matchesPrefix, virtualKeyForEntity, type VirtualKey, type VirtualPrefix } from "./keys.js";
import { resolveEntityLeaf, type LeafAddress } from "./routing.js";
import type { StorageEnv } from "./environment.js";

export type OwnerPlan = Readonly<{prefix: VirtualPrefix; directoryEpoch: number; visibleSeq: number;
  reservationTicket: number; publicationSeq: number; entities: readonly Uri[]}>;
export type ParticipantPlan = Readonly<{address: LeafAddress; owner: VirtualPrefix; entries: readonly Readonly<{index: number; virtualKey: VirtualKey}>[]}>;
export type WritePlan = Readonly<{owners: readonly OwnerPlan[]; participants: readonly ParticipantPlan[]}>;

export async function planBatch(env: StorageEnv, graphId: string, batch: FactBatch,
  directory: (prefix: VirtualPrefix) => Promise<Readonly<{directoryEpoch: number; visibleSeq: number}>>): Promise<WritePlan> {
  const graph = parseGraphId(graphId); if (!graph.ok) throw new Error("corrupt journal graph");
  const keyByEntity = new Map<Uri, VirtualKey>();
  for (const fact of batch.facts) if (!keyByEntity.has(fact.entity)) keyByEntity.set(fact.entity, await virtualKeyForEntity(graph.value, fact.entity));
  const prefixes = [...new Set([...keyByEntity.values()].map(treeForKey))].sort();
  const owners = await Promise.all(prefixes.map(async prefix => ({prefix, ...await directory(prefix), reservationTicket: 0, publicationSeq: 0,
    entities: [...keyByEntity].filter(([, key]) => treeForKey(key) === prefix).map(([entity]) => entity).sort()})));
  const groups = new Map<VirtualPrefix, {address: LeafAddress; owner: VirtualPrefix; entries: {index: number; virtualKey: VirtualKey}[]}>();
  const routes = new Map<Uri, LeafAddress>();
  for (const [index, fact] of batch.facts.entries()) {
    const key = keyByEntity.get(fact.entity)!, owner = treeForKey(key), snapshot = owners.find(o => o.prefix === owner)!;
    let address = routes.get(fact.entity);
    if (!address) {address = (await resolveEntityLeaf(env, graph.value, fact.entity, snapshot.directoryEpoch)).address; routes.set(fact.entity, address);}
    const group = groups.get(address.prefix) ?? {address, owner, entries: []};
    group.entries.push({index, virtualKey: key}); groups.set(address.prefix, group);
  }
  return {owners, participants: [...groups.values()]};
}

// Parse compact durable metadata, then verify its complete partition against
// the canonical journal before any recovery RPC. It is never a second batch.
export async function parseWritePlan(
  json: string,
  graphId: string,
  batch: FactBatch,
  reservation: "optional" | "required",
): Promise<WritePlan> {
  const raw: unknown = JSON.parse(json);
  if (!isRecord(raw) || !Array.isArray(raw["owners"]) || !Array.isArray(raw["participants"])) {
    throw new Error("invalid durable plan");
  }
  const owners = raw["owners"].map(value => parseOwner(value, reservation));
  if (!owners.length || owners.length > 16 || !isStrictlySorted(owners.map(owner => owner.prefix))) {
    throw new Error("invalid owner partition");
  }
  const participants = raw["participants"].map(value => parseParticipant(value, owners));
  if (!participants.length || participants.length > MAX_TRANSACTION_PARTICIPANTS ||
      new Set(participants.map(participant => participant.address.prefix)).size !== participants.length) {
    throw new Error("invalid physical partition");
  }
  const plan = {owners, participants};
  await verifyJournalPartition(plan, graphId, batch);
  return plan;
}

function parseOwner(value: unknown, reservation: "optional" | "required"): OwnerPlan {
  if (!isRecord(value)) throw new Error("invalid durable owner");
  const prefix = parseVirtualPrefix(value["prefix"]);
  if (!prefix.ok || prefix.value.length !== TREE_DEPTH || !Array.isArray(value["entities"]) || !value["entities"].length) {
    throw new Error("invalid owner identity");
  }
  const entities = value["entities"].map(entity => {
    const parsed = parseUri(entity);
    if (!parsed.ok) throw new Error("invalid durable entity");
    return parsed.value;
  });
  if (!isStrictlySorted(entities)) throw new Error("unordered owner entities");
  return {
    prefix: prefix.value,
    entities,
    directoryEpoch: integer(value["directoryEpoch"]),
    visibleSeq: integer(value["visibleSeq"]),
    reservationTicket: integer(value["reservationTicket"], reservation === "required" ? 1 : 0),
    publicationSeq: integer(value["publicationSeq"]),
  };
}

function parseParticipant(value: unknown, owners: readonly OwnerPlan[]): ParticipantPlan {
  if (!isRecord(value) || !isRecord(value["address"]) || !Array.isArray(value["entries"]) || !value["entries"].length) {
    throw new Error("invalid participant plan");
  }
  const prefix = parseVirtualPrefix(value["address"]["prefix"]);
  const owner = parseVirtualPrefix(value["owner"]);
  if (!prefix.ok || !owner.ok || !owners.some(candidate => candidate.prefix === owner.value) || !prefix.value.startsWith(owner.value)) {
    throw new Error("participant escapes owner");
  }
  const entries = value["entries"].map(entry => {
    if (!isRecord(entry)) throw new Error("invalid plan index");
    const key = parseVirtualKey(entry["virtualKey"]);
    if (!key.ok || !matchesPrefix(key.value, prefix.value) || treeForKey(key.value) !== owner.value) throw new Error("invalid plan key");
    return {index: integer(entry["index"]), virtualKey: key.value};
  });
  if (entries.some((entry, index) => index > 0 && entry.index <= entries[index - 1]!.index)) {
    throw new Error("unordered journal partition");
  }
  return {address: {prefix: prefix.value, generation: integer(value["address"]["generation"])}, owner: owner.value, entries};
}

async function verifyJournalPartition(plan: WritePlan, graphId: string, batch: FactBatch): Promise<void> {
  const seen = new Set<number>();
  const entitiesByOwner = new Map<VirtualPrefix, Set<Uri>>();
  const keys = new Map<Uri, VirtualKey>();
  for (const participant of plan.participants) {
    for (const entry of participant.entries) {
      const fact = batch.facts[entry.index];
      if (!fact || seen.has(entry.index)) throw new Error("incomplete/duplicate journal partition");
      let key = keys.get(fact.entity);
      if (!key) {
        key = await virtualKeyForEntity(graphId, fact.entity);
        keys.set(fact.entity, key);
      }
      if (key !== entry.virtualKey) throw new Error("journal key binding mismatch");
      seen.add(entry.index);
      const entities = entitiesByOwner.get(participant.owner) ?? new Set<Uri>();
      entities.add(fact.entity);
      entitiesByOwner.set(participant.owner, entities);
    }
  }
  if (seen.size !== batch.facts.length) throw new Error("journal partition lost facts");
  for (const owner of plan.owners) {
    const entities = [...(entitiesByOwner.get(owner.prefix) ?? [])].sort();
    if (entities.length !== owner.entities.length || entities.some((entity, index) => entity !== owner.entities[index])) {
      throw new Error("journal entity-set binding mismatch");
    }
  }
}

function isStrictlySorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

export function integer(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new Error("invalid durable/control integer");
  return value;
}
