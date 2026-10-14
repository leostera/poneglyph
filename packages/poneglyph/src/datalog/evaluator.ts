import type { BuiltinName, DatalogQuery, FactClause, Term } from "./ast.js";
import type { FactSource, FactTuple } from "./fact-source.js";
import { compareDatalogValues, sameDatalogValue, type DatalogValue } from "./value.js";

export type Binding = ReadonlyMap<string, DatalogValue>;

export type EvaluationOptions = Readonly<{
  maxResults?: number;
  signal?: AbortSignal;
}>;

const DEFAULT_MAX_RESULTS = 10_000;

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
  for await (const binding of evaluateFacts(
    query.facts,
    facts,
    options.signal,
    0,
    new Map<string, DatalogValue>(),
  )) {
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
