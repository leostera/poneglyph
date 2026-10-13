import {coordinatorObjectName} from "../../../poneglyph/src/database-implementation.js";
import type {AuthorityLayout, AuthorityRole} from "./authority-sql.js";
export const authorityLayout: AuthorityLayout = {candidate: false, entityLocks: false, publication: "none"};
export async function authorityActors(graph: string, _txIds: readonly string[]): Promise<{name: string; role: AuthorityRole}[]> {
  return [{name: coordinatorObjectName(graph), role: "graph"}];
}
