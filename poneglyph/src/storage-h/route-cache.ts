import type { GraphId } from "../domain/graph-id.js";
import type { CandidateStorageEnv } from "./environment.js";
import { treeForKey } from "./forest.js";
import { matchesPrefix, parseVirtualPrefix, type VirtualKey, type VirtualPrefix } from "./keys.js";
import { resolveKeyLeaf, type LeafAddress } from "./routing.js";

const MAX_CACHED_LEAVES = 128;
type CachedLeaf = Readonly<{owner: VirtualPrefix; epoch: number; address: LeafAddress}>;

// Provisional hints only. Every plan still obtains a fresh owner epoch, and
// reservations/participants fence that exact epoch/generation before mutation.
// Never use this cache to regroup or reroute an admitted durable plan.
export class RouteCache {
  private graph: GraphId | undefined;
  private readonly epochs = new Map<VirtualPrefix, number>();
  private readonly leaves = new Map<VirtualPrefix, CachedLeaf>();

  async resolve(env: CandidateStorageEnv, graph: GraphId, key: VirtualKey, epoch: number): Promise<LeafAddress> {
    const cached = this.get(graph, key, epoch);
    if (cached) return cached;
    const {address} = await resolveKeyLeaf(env, graph, key, epoch);
    this.put(graph, key, epoch, address);
    return address;
  }

  get(graph: GraphId, key: VirtualKey, epoch: number): LeafAddress | undefined {
    const owner = treeForKey(key);
    if (!this.observeEpoch(graph, owner, epoch)) return undefined;
    for (const [prefix, leaf] of this.leaves) {
      if (leaf.owner !== owner || leaf.epoch !== epoch || !matchesPrefix(key, prefix)) continue;
      this.leaves.delete(prefix); this.leaves.set(prefix, leaf);
      return leaf.address;
    }
    return undefined;
  }

  put(graph: GraphId, key: VirtualKey, epoch: number, address: LeafAddress): void {
    const owner = treeForKey(key), prefix = parseVirtualPrefix(address.prefix);
    if (!prefix.ok || !prefix.value.startsWith(owner) || !matchesPrefix(key, prefix.value) ||
        !Number.isSafeInteger(address.generation) || address.generation < 0)
      throw new Error("invalid provisional cache range");
    if (!this.observeEpoch(graph, owner, epoch)) return; // Older concurrent snapshot, not a rollback.
    for (const leaf of this.leaves.values()) {
      if (leaf.owner !== owner) continue;
      if (leaf.address.prefix === prefix.value && leaf.address.generation === address.generation) continue;
      if (leaf.address.prefix.startsWith(prefix.value) || prefix.value.startsWith(leaf.address.prefix))
        throw new Error("conflicting provisional routes within one owner epoch");
    }
    this.leaves.delete(prefix.value);
    this.leaves.set(prefix.value, {owner, epoch, address: Object.freeze({...address})});
    while (this.leaves.size > MAX_CACHED_LEAVES) this.leaves.delete(this.leaves.keys().next().value!);
  }

  private observeEpoch(graph: GraphId, owner: VirtualPrefix, epoch: number): boolean {
    if (this.graph !== undefined && this.graph !== graph) throw new Error("provisional cache graph identity conflict");
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("invalid provisional cache epoch");
    this.graph = graph;
    const current = this.epochs.get(owner);
    if (current !== undefined && epoch < current) return false;
    if (current === epoch) return true;
    for (const [prefix, leaf] of this.leaves) if (leaf.owner === owner) this.leaves.delete(prefix);
    this.epochs.set(owner, epoch);
    return true;
  }
}
