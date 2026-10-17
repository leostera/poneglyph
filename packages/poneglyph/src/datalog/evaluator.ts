import type { BuiltinName, DatalogQuery, FactClause, Term } from "./ast.js";
import type { FactSource, FactTuple } from "./fact-source.js";
import { compareDatalogValues, sameDatalogValue, type DatalogValue } from "./value.js";

export type Binding = ReadonlyMap<string, DatalogValue>;

export type EvaluationOptions = Readonly<{
  maxResults?: number;
  signal?: AbortSignal;
}>;

const DEFAULT_MAX_RESULTS = 10_000;
const MAX_CONCURRENT_FINAL_SCANS = 4;
const MAX_FINAL_JOIN_BINDINGS = 16;

export class QueryResultLimitExceeded extends Error {
  constructor(readonly maxResults: number) {
    super(`query result limit exceeded (${maxResults})`);
    this.name = "QueryResultLimitExceeded";
  }
}

export async function* evaluateDatalog(
  query: DatalogQuery,
  facts: FactSource,
  options: EvaluationOptions = {},
): AsyncGenerator<Binding> {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  if (!Number.isSafeInteger(maxResults) || maxResults < 1) {
    throw new RangeError("maxResults must be a positive safe integer");
  }

  let emitted = 0;
  for await (const binding of evaluateQueryFacts(query.facts, facts, options.signal)) {
    throwIfAborted(options.signal);
    if (query.constraints.every((constraint) => {
      const left = resolveTerm(constraint.left, binding);
      const right = resolveTerm(constraint.right, binding);
      return left !== undefined && right !== undefined && evaluateBuiltin(constraint.name, left, right);
    })) {
      if (emitted === maxResults) throw new QueryResultLimitExceeded(maxResults);
      emitted += 1;
      yield binding;
    }
  }
}

async function* evaluateQueryFacts(
  clauses: readonly FactClause[], facts: FactSource, signal: AbortSignal | undefined,
): AsyncGenerator<Binding> {
  const [filter, output] = clauses;
  // This physical operator needs no cross-entity exchange. Distinct variables
  // keep repeated-variable unification on the general evaluation path.
  if (facts.scanEntityJoin && clauses.length === 2 && filter && output &&
      filter.entity.kind === "variable" && output.entity.kind === "variable" &&
      filter.entity.name === output.entity.name && filter.value.kind === "constant" &&
      output.value.kind === "variable" && output.value.name !== filter.entity.name) {
    for await (const tuple of facts.scanEntityJoin({field: filter.predicate, value: filter.value.value}, output.predicate, signal)) {
      throwIfAborted(signal);
      yield new Map([[filter.entity.name, tuple.entity], [output.value.name, tuple.value]]);
    }
    return;
  }
  if (canScanFinalJoinConcurrently(clauses)) {
    if (facts.scanValues) yield* evaluateFinalJoinBatched(clauses, facts, signal);
    else yield* evaluateFinalJoinConcurrently(clauses, facts, signal);
    return;
  }
  yield* evaluateFacts(clauses, facts, signal, 0, new Map<string, DatalogValue>());
}

function canScanFinalJoinConcurrently(clauses: readonly FactClause[]): boolean {
  if (clauses.length !== 3) return false;
  const first = clauses[0];
  const final = clauses[2];
  if (!first || !final || first.entity.kind !== "variable" || first.value.kind !== "constant") return false;
  if (final.entity.kind !== "variable" || final.value.kind !== "variable" || final.entity.name === final.value.name) return false;

  const finalEntityName = final.entity.name;
  const finalValueName = final.value.name;
  const prefix = clauses.slice(0, -1);
  const finalEntityIsAlreadyBound = prefix.some(clause => clauseHasVariable(clause, finalEntityName));
  const finalValueIsBound = prefix.some(clause => clauseHasVariable(clause, finalValueName));
  return !finalEntityIsAlreadyBound && finalValueIsBound;
}

function clauseHasVariable(clause: FactClause, name: string): boolean {
  return (clause.entity.kind === "variable" && clause.entity.name === name)
    || (clause.value.kind === "variable" && clause.value.name === name);
}

async function* evaluateFinalJoinConcurrently(
  clauses: readonly FactClause[], facts: FactSource, signal: AbortSignal | undefined,
): AsyncGenerator<Binding> {
  const final = clauses[2];
  if (!final) return;
  const prefix = evaluateFacts(clauses.slice(0, -1), facts, signal, 0, new Map<string, DatalogValue>())[Symbol.asyncIterator]();
  let prefixDone = false;

  try {
    while (!prefixDone) {
      const scans: Promise<Binding[]>[] = [];
      let prefixFailure: unknown;
      let prefixFailed = false;

      while (scans.length < MAX_CONCURRENT_FINAL_SCANS) {
        let next: IteratorResult<Binding>;
        try {
          next = await prefix.next();
        } catch (error) {
          prefixFailure = error;
          prefixFailed = true;
          break;
        }
        if (next.done) {
          prefixDone = true;
          break;
        }
        const binding = next.value;
        const lookup = lookupFor(final, binding);
        scans.push(Promise.resolve().then(() => collectFinalMatches(facts.scan(lookup, signal), final, binding, signal)));
      }

      const settled = await Promise.allSettled(scans);
      if (prefixFailed) throw prefixFailure;
      const failedScan = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failedScan) throw failedScan.reason;

      for (const result of settled) {
        if (result.status === "fulfilled") {
          for (const binding of result.value) yield binding;
        }
      }
    }
  } finally {
    await prefix.return?.(undefined);
  }
}

async function* evaluateFinalJoinBatched(
  clauses: readonly FactClause[], facts: FactSource, signal: AbortSignal | undefined,
): AsyncGenerator<Binding> {
  const final = clauses[2];
  if (!final || final.value.kind !== "variable" || !facts.scanValues) return;
  const bindingsByValue = new Map<string, {value: DatalogValue; bindings: Binding[]}>();
  const prefix = evaluateFacts(clauses.slice(0, -1), facts, signal, 0, new Map<string, DatalogValue>())[Symbol.asyncIterator]();
  let prefixDone = false;
  let bufferedBindings = 0;

  const flush = async function* (): AsyncGenerator<Binding> {
    if (bindingsByValue.size === 0) return;
    const values = [...bindingsByValue.values()].map(group => group.value);
    for await (const tuple of facts.scanValues!({field: final.predicate, values}, signal)) {
      throwIfAborted(signal);
      const matches = bindingsByValue.get(valueKey(tuple.value))?.bindings;
      if (!matches) continue;
      for (const binding of matches) {
        const next = new Map(binding);
        if (unify(final.entity, tuple.entity, next) && unify(final.value, tuple.value, next)) yield next;
      }
    }
    bindingsByValue.clear();
    bufferedBindings = 0;
  };

  try {
    while (!prefixDone) {
      const next = await prefix.next();
      if (next.done) {
        prefixDone = true;
        yield* flush();
        continue;
      }
      const binding = next.value;
      const value = binding.get(final.value.name);
      if (value === undefined) throw new Error(`final join value ${final.value.name} is not bound`);
      const key = valueKey(value);
      let group = bindingsByValue.get(key);
      if (group === undefined) {
        if (bindingsByValue.size === MAX_FINAL_JOIN_BINDINGS) yield* flush();
        group = {value, bindings: []};
        bindingsByValue.set(key, group);
      }
      group.bindings.push(binding);
      bufferedBindings += 1;
      if (bufferedBindings >= MAX_FINAL_JOIN_BINDINGS) yield* flush();
    }
  } finally {
    await prefix.return?.(undefined);
  }
}

function valueKey(value: DatalogValue): string {
  return JSON.stringify([value.type, value.value]);
}

async function collectFinalMatches(
  tuples: AsyncIterable<FactTuple>, clause: FactClause, binding: Binding, signal: AbortSignal | undefined,
): Promise<Binding[]> {
  const matches: Binding[] = [];
  for await (const tuple of tuples) {
    throwIfAborted(signal);
    const nextBinding = new Map(binding);
    if (!unify(clause.entity, tuple.entity, nextBinding)) continue;
    if (!unify(clause.value, tuple.value, nextBinding)) continue;
    matches.push(nextBinding);
  }
  return matches;
}

async function* evaluateFacts(
  clauses: readonly FactClause[],
  facts: FactSource,
  signal: AbortSignal | undefined,
  clauseIndex: number,
  binding: Map<string, DatalogValue>,
): AsyncGenerator<Binding> {
  throwIfAborted(signal);
  if (clauseIndex === clauses.length) {
    yield new Map(binding);
    return;
  }

  const clause = clauses[clauseIndex];
  if (clause === undefined) return;
  const lookup = lookupFor(clause, binding);

  for await (const tuple of facts.scan(lookup, signal)) {
    throwIfAborted(signal);
    const nextBinding = new Map(binding);
    if (!unify(clause.entity, tuple.entity, nextBinding)) continue;
    if (!unify(clause.value, tuple.value, nextBinding)) continue;

    yield* evaluateFacts(clauses, facts, signal, clauseIndex + 1, nextBinding);
  }
}

function lookupFor(clause: FactClause, binding: Binding) {
  const lookup: { field: FactClause["predicate"]; entity?: DatalogValue; value?: DatalogValue } = {
    field: clause.predicate,
  };
  const entity = resolveTerm(clause.entity, binding);
  if (entity !== undefined) lookup.entity = entity;
  const value = resolveTerm(clause.value, binding);
  if (value !== undefined) lookup.value = value;
  return lookup;
}

function resolveTerm(term: Term, binding: Binding): DatalogValue | undefined {
  switch (term.kind) {
    case "constant":
      return term.value;
    case "variable":
      return binding.get(term.name);
    case "wildcard":
      return undefined;
  }
}

function unify(term: Term, value: DatalogValue, binding: Map<string, DatalogValue>): boolean {
  switch (term.kind) {
    case "constant":
      return sameDatalogValue(term.value, value);
    case "wildcard":
      return true;
    case "variable": {
      const existing = binding.get(term.name);
      if (existing !== undefined) return sameDatalogValue(existing, value);
      binding.set(term.name, value);
      return true;
    }
  }
}

function evaluateBuiltin(
  name: BuiltinName,
  left: DatalogValue,
  right: DatalogValue,
): boolean {
  const ordering = compareDatalogValues(left, right);
  switch (name) {
    case "=":
    case "eq":
      return sameDatalogValue(left, right);
    case "<":
    case "lt":
    case "before":
      return ordering !== undefined && ordering < 0;
    case "<=":
    case "lte":
      return ordering !== undefined && ordering <= 0;
    case ">":
    case "gt":
    case "after":
      return ordering !== undefined && ordering > 0;
    case ">=":
    case "gte":
      return ordering !== undefined && ordering >= 0;
    case "contains":
      return stringPair(left, right, (value, part) => value.includes(part));
    case "startsWith":
      return stringPair(left, right, (value, prefix) => value.startsWith(prefix));
    case "endsWith":
      return stringPair(left, right, (value, suffix) => value.endsWith(suffix));
  }
}

function stringPair(
  left: DatalogValue,
  right: DatalogValue,
  matches: (value: string, pattern: string) => boolean,
): boolean {
  return left.type === "string" && right.type === "string" && matches(left.value, right.value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException("Query was aborted", "AbortError");
  }
}
