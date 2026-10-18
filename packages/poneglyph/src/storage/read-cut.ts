import type { DatalogQuery } from "../datalog/ast.js";
import type { GraphId } from "../domain/graph-id.js";
import { parseUri } from "../domain/identifiers.js";
import type { StorageEnv } from "./environment.js";
import { TREE_PREFIXES, treeCoordinatorName, treeForKey, type TreeSnapshot } from "./forest.js";
import { virtualKeyForEntity, type VirtualPrefix } from "./keys.js";
import { readFailureReason, type ReadFailureReason } from "./read-diagnostics.js";

// Literal entity terms bound every scan to those owners, even when value
// variables join across clauses. Capture their union from ONE safe vector;
// independently capturing each owner would lose transaction closure.
export async function queryReadPrefixes(graphId: GraphId, query: DatalogQuery): Promise<readonly VirtualPrefix[]> {
  if (query.facts.length === 0) return TREE_PREFIXES;
  const entities = new Set<string>();
  for (const clause of query.facts) {
    if (clause.entity.kind !== "constant" || clause.entity.value.type !== "string") return TREE_PREFIXES;
    const entity = parseUri(clause.entity.value.value);
    if (!entity.ok) return TREE_PREFIXES;
    entities.add(entity.value);
  }
  const owners = new Set(await Promise.all([...entities].map(async entity =>
    treeForKey(await virtualKeyForEntity(graphId, entity)))));
  return TREE_PREFIXES.filter(prefix => owners.has(prefix));
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
    // Consume the acknowledgement body to release the connection even though
    // expiry, not successful cleanup delivery, is the safety fence.
    await response.body?.cancel();
    return response.ok;
  }));
  const failures: Partial<Record<ReadFailureReason | "upstream-status", number>> = {};
  for (const result of released) {
    const reason = result.status === "rejected" ? readFailureReason(result.reason)
      : result.value ? undefined : "upstream-status";
    if (reason !== undefined) failures[reason] = (failures[reason] ?? 0) + 1;
  }
  if (Object.keys(failures).length > 0) {
    console.warn({event: "poneglyph.read.release_deferred", stage: "release", failures, leaseCount: cut.length});
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
