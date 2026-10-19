import type {Query} from "./model.js";

// This catalogue stores final-replay specifications, never responses. Explicit
// reads still execute at every historical checkpoint. Predicate closures are
// opaque and are deliberately not deduplicated.
export class QueryCatalogue {
  private readonly entries: Query[] = [];
  private readonly unfiltered = new Set<string>();
  remember(query: Query) {
    if (query.filter === undefined) {
      const key = JSON.stringify([query.source, query.atoms]);
      if (this.unfiltered.has(key)) return;
      this.unfiltered.add(key);
    }
    this.entries.push({...query, atoms: structuredClone(query.atoms)});
  }
  get queries(): readonly Query[] {return this.entries.map(query => ({...query, atoms: structuredClone(query.atoms)}));}
  inherit(queries: readonly Query[]) {for (const query of queries) this.remember(query);}
}
