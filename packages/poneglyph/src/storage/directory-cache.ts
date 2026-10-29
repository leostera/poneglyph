import type { GraphId } from "../domain/graph-id.js";
import type { StorageEnv } from "./environment.js";
import { matchesPrefix, type VirtualKey, type VirtualPrefix } from "./keys.js";
import { resolveKeyLeaf, type LeafAddress } from "./routing.js";

export type OwnerDirectoryEntry = Readonly<{directoryEpoch: number; visibleSeq: number}>;

const MAX_OWNER_ENTRIES = 4_096;
const MAX_LEAF_SETS = 4_096;

/**
 * Isolate-local write-planning caches for a ledger.
 *
 * Owner directories are hints: a stale epoch is rejected by the owner's lock,
 * and the ledger then invalidates the entry and plans again. Leaf routes are
 * facts: at a fixed directory epoch the leaves of an owner never change (a
 * split always publishes a new epoch), so a cached leaf that covers a key is
 * the answer the directory would give.
 */
export class WriteDirectoryCache {
  private readonly owners = new Map<string, OwnerDirectoryEntry>();
  private readonly leaves = new Map<string, LeafAddress[]>();

  async owner(graphId: string, prefix: VirtualPrefix, load: () => Promise<OwnerDirectoryEntry>): Promise<OwnerDirectoryEntry> {
    const key = `${graphId}\u0000${prefix}`;
    const cached = this.owners.get(key);
    if (cached !== undefined) return cached;
    const entry = await load();
    remember(this.owners, key, entry, MAX_OWNER_ENTRIES);
    return entry;
  }

  forgetOwners(graphId: string, prefixes: readonly VirtualPrefix[]): void {
    for (const prefix of prefixes) this.owners.delete(`${graphId}\u0000${prefix}`);
  }

  async leaf(env: StorageEnv, graphId: GraphId, owner: VirtualPrefix, key: VirtualKey, directoryEpoch: number): Promise<LeafAddress> {
    const setKey = `${graphId}\u0000${owner}\u0000${directoryEpoch}`;
    const known = this.leaves.get(setKey);
    const hit = known?.find(leaf => matchesPrefix(key, leaf.prefix));
    if (hit !== undefined) return hit;
    const {address} = await resolveKeyLeaf(env, graphId, key, directoryEpoch);
    const next = [...(known ?? []), address];
    this.leaves.delete(setKey);
    remember(this.leaves, setKey, next, MAX_LEAF_SETS);
    return address;
  }
}

function remember<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
}

export const writeDirectoryCache = new WriteDirectoryCache();
