import { TREE_PREFIXES, type TreeSnapshot } from "./forest.js";
import type { VirtualPrefix } from "./keys.js";

// Every successful lease fences writes/topology until release. Only evaluate
// after all requested owners settle: at that instant the selected vector is
// pinned. A failed sibling must not cause cleanup before a late success settles.
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
