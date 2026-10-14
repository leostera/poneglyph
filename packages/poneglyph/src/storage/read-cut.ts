import { TREE_PREFIXES, type TreeSnapshot } from "./forest.js";
import type { VirtualPrefix } from "./keys.js";

// Every successful lease fences writes/topology until release. Only evaluate
// after all owners settle: at that instant the entire vector is pinned. A failed
// sibling must not cause cleanup before a late successful acquisition finishes.
export async function acquireParallelReadCut(
  acquire: (prefix: VirtualPrefix) => Promise<TreeSnapshot>,
  release: (cut: readonly TreeSnapshot[]) => Promise<void>,
): Promise<TreeSnapshot[]> {
  const results = await Promise.allSettled(TREE_PREFIXES.map(acquire));
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
