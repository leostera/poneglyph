import type { DatalogQuery } from "../datalog/ast.js";
import type { GraphId } from "../domain/graph-id.js";
import { parseUri } from "../domain/identifiers.js";
import type { StorageEnv } from "./environment.js";
import { TREE_PREFIXES, treeCoordinatorName, treeForKey, type TreeSnapshot } from "./forest.js";
import { virtualKeyForEntity, type VirtualPrefix } from "./keys.js";

// A single relation with a literal entity is confined to one root; every
// broader shape keeps the full vector because it may read across roots.
export async function queryReadPrefixes(graphId: GraphId, query: DatalogQuery): Promise<readonly VirtualPrefix[]> {
  const clause = query.facts.length === 1 ? query.facts[0] : undefined;
  if (clause?.entity.kind === "constant" && clause.entity.value.type === "string") {
    const entity = parseUri(clause.entity.value.value);
    if (entity.ok) return [treeForKey(await virtualKeyForEntity(graphId, entity.value))];
  }
  return TREE_PREFIXES;
}

// Release exact lease identities. Unknown delivery leaves the lease expiry as
// the fence; cleanup failure must not turn a complete answer into a partial one.
export async function releaseParallelReadCut(
  env: StorageEnv,
  graphId: GraphId,
  cut: readonly TreeSnapshot[],
): Promise<void> {
  const released = await Promise.allSettled(cut.map(async lease => {
    const response = await env.GRAPH_TREES.getByName(treeCoordinatorName(graphId, lease.prefix)).fetch("https://tree.internal/_tree-release-read", {
      method: "POST", body: JSON.stringify({ graphId, prefix: lease.prefix, readId: lease.readId }),
    });
    if (!response.ok) console.warn("subtree read release deferred", lease.prefix);
  }));
  for (const result of released) {
    if (result.status === "rejected") console.warn("subtree read release delivery unknown; lease expiry remains the fence");
  }
}

// Leases pin exact MVCC components and fence topology/history pruning, not
// writes. Evaluate only after every requested owner settles; a failed sibling
// must not cause cleanup before a late successful pin settles.
export async function acquireParallelReadCut(
  acquire: (prefix: VirtualPrefix) => Promise<TreeSnapshot>,
  release: (cut: readonly TreeSnapshot[]) => Promise<void>,
  prefixes: readonly VirtualPrefix[] = TREE_PREFIXES,
): Promise<TreeSnapshot[]> {
  const uniquePrefixes = new Set(prefixes);
  if (prefixes.length === 0 || uniquePrefixes.size !== prefixes.length ||
      prefixes.some(prefix => !TREE_PREFIXES.includes(prefix))) {
    throw new TypeError("read cut must contain unique independent tree roots");
  }
  const results = await Promise.allSettled(prefixes.map(acquire));
  const cut = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  const failure = results.find(result => result.status === "rejected");
  if (failure?.status === "rejected") {
    await release(cut);
    throw failure.reason;
  }
  if (cut.some(lease => lease.expiresAtMs <= Date.now())) {
    await release(cut);
    throw new Error("subtree read cut expired during acquisition");
  }
  return cut;
}
