import type { FactDraft } from "../../src/domain/fact.js";
import type { Uri } from "../../src/domain/identifiers.js";
import { factValueToDatalogValues, sameDatalogValue, stringValue } from "../../src/datalog/value.js";
import type { FactLookup, FactSource, FactTuple } from "../../src/datalog/fact-source.js";

export class InMemoryFactSource implements FactSource {
  readonly lookups: FactLookup[] = [];
  private readonly tuples: readonly Readonly<{ field: Uri; tuple: FactTuple }>[];

  constructor(facts: readonly FactDraft[]) {
    const tuples = facts.flatMap((fact) => factValueToDatalogValues(fact.value).map((value) => ({
      field: fact.field,
      tuple: Object.freeze({ entity: stringValue(fact.entity), value }),
    })));
    this.tuples = Object.freeze(tuples);
  }

  async *scan(lookup: FactLookup, signal?: AbortSignal): AsyncGenerator<FactTuple> {
    this.lookups.push(Object.freeze({ ...lookup }));
    for (const row of this.tuples) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new DOMException("Scan aborted", "AbortError");
      }
      if (row.field !== lookup.field) continue;
      if (lookup.entity !== undefined && !sameDatalogValue(row.tuple.entity, lookup.entity)) continue;
      if (lookup.value !== undefined && !sameDatalogValue(row.tuple.value, lookup.value)) continue;
      yield row.tuple;
    }
  }
}
