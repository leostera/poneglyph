import {coordinatorObjectName, type VirtualPrefix} from "../../poneglyph/src/storage/keys.js";
import {TREE_PREFIXES, treeCoordinatorName, transactionCoordinatorName} from "../../poneglyph/src/storage/forest.js";
import type {AuthorityRole} from "./authority-sql.js";
export function ownerActorName(graph: string, prefix: VirtualPrefix) {return treeCoordinatorName(graph, prefix);}
export async function authorityActors(graph: string, txIds: readonly string[]): Promise<{name: string; role: AuthorityRole}[]> {
  const ledgers = [...new Set(await Promise.all(txIds.map(tx => transactionCoordinatorName(graph, tx))))];
  return [{name: coordinatorObjectName(graph), role: "graph"},
    ...TREE_PREFIXES.map(prefix => ({name: treeCoordinatorName(graph, prefix), role: "owner" as const})),
    ...ledgers.map(name => ({name, role: "ledger" as const}))];
}
