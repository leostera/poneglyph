import type { GraphId } from "../domain/graph-id.js";
import type { CandidateStorageEnv as Env } from "./environment.js";
import { isRecord } from "../domain/result.js";
import {
  MAX_DIRECTORY_DEPTH,
  MAX_DIRECTORY_LOOKUP_HOPS,
  MAX_QUERY_DIRECTORY_NODES,
  MAX_QUERY_SHARD_FANOUT,
} from "./constants.js";
import {
  bitAt,
  matchesPrefix,
  parseVirtualPrefix,
  shardObjectName,
  virtualKeyForEntity,
  type VirtualKey,
  type VirtualPrefix,
} from "./keys.js";

export type LeafAddress = Readonly<{ prefix: VirtualPrefix; generation: number }>;
export type RoutedLeaf = Readonly<{ address: LeafAddress; directoryHops: number }>;
export type DirectoryListing = Readonly<{ leaves: readonly LeafAddress[]; directoryHops: number }>;

type DirectoryNode =
  | Readonly<{ kind: "leaf"; prefix: VirtualPrefix; generation: number }>
  | Readonly<{
      kind: "router";
      prefix: VirtualPrefix;
      generation: number;
      splitEpoch: number;
      children: readonly [VirtualPrefix, VirtualPrefix];
      retired: boolean;
    }>;

export async function resolveEntityLeaf(
  env: Env,
  graphId: GraphId,
  entity: string,
  directoryEpoch: number,
): Promise<RoutedLeaf> {
  const key = await virtualKeyForEntity(graphId, entity);
  return resolveKeyLeaf(env, graphId, key, directoryEpoch);
}

export async function resolveKeyLeaf(
  env: Env,
  graphId: GraphId,
  key: VirtualKey,
  directoryEpoch: number,
): Promise<RoutedLeaf> {
  let prefix: VirtualPrefix = "" as VirtualPrefix;
  for (let hop = 0; hop < MAX_DIRECTORY_LOOKUP_HOPS; hop += 1) {
    const node = await readDirectoryNode(env, graphId, prefix, directoryEpoch, key);
    if (node.kind === "leaf" || directoryEpoch < node.splitEpoch) {
      if (node.kind === "router" && node.retired) {
        throw new DirectoryRouteError(410, "the requested directory epoch has retired");
      }
      if (!matchesPrefix(key, node.prefix)) throw new DirectoryRouteError(409, "directory returned an owner outside the entity range");
      const generation = node.kind === "router" ? node.generation - 1 : node.generation;
      return { address: { prefix: node.prefix, generation }, directoryHops: hop + 1 };
    }

    if (prefix.length >= MAX_DIRECTORY_DEPTH) throw new DirectoryRouteError(507, "directory reached the full virtual-key depth");
    prefix = bitAt(key, prefix.length) === "0" ? node.children[0] : node.children[1];
  }
  throw new DirectoryRouteError(507, "directory lookup exceeded its hop budget");
}

export async function listShardLeaves(
  env: Env,
  graphId: GraphId,
  directoryEpoch: number,
): Promise<DirectoryListing> {
  const pending: VirtualPrefix[] = ["" as VirtualPrefix];
  const leaves: LeafAddress[] = [];
  let directoryHops = 0;

  while (pending.length > 0) {
    const prefix = pending.pop();
    if (prefix === undefined) break;
    directoryHops += 1;
    if (directoryHops > MAX_QUERY_DIRECTORY_NODES) {
      throw new DirectoryRouteError(413, "query directory traversal budget exceeded");
    }
    const node = await readDirectoryNode(env, graphId, prefix, directoryEpoch);
    if (node.kind === "leaf" || directoryEpoch < node.splitEpoch) {
      if (node.kind === "router" && node.retired) {
        throw new DirectoryRouteError(410, "the requested directory epoch has retired");
      }
      leaves.push({ prefix: node.prefix, generation: node.kind === "router" ? node.generation - 1 : node.generation });
      if (leaves.length > MAX_QUERY_SHARD_FANOUT) {
        throw new DirectoryRouteError(413, "query leaf fan-out budget exceeded");
      }
      continue;
    }
    pending.push(node.children[1], node.children[0]);
  }

  leaves.sort((left, right) => left.prefix.localeCompare(right.prefix));
  return { leaves, directoryHops };
}

async function readDirectoryNode(
  env: Env,
  graphId: GraphId,
  prefix: VirtualPrefix,
  directoryEpoch: number,
  key?: VirtualKey,
): Promise<DirectoryNode> {
  const stub = env.GRAPH_SHARDS.getByName(shardObjectName(graphId, prefix));
  const body: Record<string, unknown> = { graphId, prefix, directoryEpoch };
  if (key !== undefined) body["virtualKey"] = key;
  const response = await stub.fetch("https://shard.internal/_route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 256);
    throw new DirectoryRouteError(response.status, `directory lookup failed: ${detail}`);
  }

  let input: unknown;
  try {
    input = await response.json();
  } catch {
    throw new DirectoryRouteError(502, "directory returned invalid JSON");
  }
  return parseDirectoryNode(input, prefix);
}

function parseDirectoryNode(input: unknown, expectedPrefix: VirtualPrefix): DirectoryNode {
  if (!isRecord(input) || input["prefix"] !== expectedPrefix) {
    throw new DirectoryRouteError(502, "directory returned an invalid node identity");
  }
  const generation = input["generation"];
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
    throw new DirectoryRouteError(502, "directory returned an invalid generation");
  }
  if (input["kind"] === "leaf") return { kind: "leaf", prefix: expectedPrefix, generation };
  if (input["kind"] !== "router") throw new DirectoryRouteError(502, "directory returned an unknown node kind");

  const splitEpoch = input["splitEpoch"];
  const rawChildren = input["children"];
  if (!Number.isSafeInteger(splitEpoch) || typeof splitEpoch !== "number" || splitEpoch < 1 || !Array.isArray(rawChildren) || rawChildren.length !== 2) {
    throw new DirectoryRouteError(502, "directory returned invalid split metadata");
  }
  const left = parseVirtualPrefix(rawChildren[0]);
  const right = parseVirtualPrefix(rawChildren[1]);
  if (!left.ok || !right.ok || left.value !== `${expectedPrefix}0` || right.value !== `${expectedPrefix}1`) {
    throw new DirectoryRouteError(502, "directory returned invalid child prefixes");
  }
  if (typeof input["retired"] !== "boolean") throw new DirectoryRouteError(502, "directory returned an invalid retirement flag");
  return {
    kind: "router",
    prefix: expectedPrefix,
    generation,
    splitEpoch,
    children: [left.value, right.value],
    retired: input["retired"],
  };
}

export class DirectoryRouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "DirectoryRouteError";
  }
}
