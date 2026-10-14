import type { NonEmptyReadonlyArray } from "../domain/fact.js";
import { parsed, rejected, type ParseResult } from "../domain/result.js";
import type { Uri } from "../domain/identifiers.js";
import type { DatalogValue } from "./value.js";

export type Term =
  | Readonly<{ kind: "variable"; name: string }>
  | Readonly<{ kind: "constant"; value: DatalogValue }>
  | Readonly<{ kind: "wildcard" }>;

export type FactClause = Readonly<{
  kind: "fact";
  predicate: Uri;
  entity: Term;
  value: Term;
}>;

export type BuiltinName =
  | "="
  | "<"
  | "<="
  | ">"
  | ">="
  | "eq"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "before"
  | "after"
  | "contains"
  | "startsWith"
  | "endsWith";

export type BuiltinClause = Readonly<{
  kind: "builtin";
  name: BuiltinName;
  left: Term;
  right: Term;
}>;

export type DatalogClause = FactClause | BuiltinClause;

export type DatalogQuery = Readonly<{
  facts: NonEmptyReadonlyArray<FactClause>;
  constraints: readonly BuiltinClause[];
}>;

export const MAX_QUERY_CLAUSES = 64;

export function createDatalogQuery(
  facts: readonly FactClause[],
  constraints: readonly BuiltinClause[],
): ParseResult<DatalogQuery> {
  if (facts.length === 0) {
    return rejected("query", "a query must contain at least one positive fact relation");
  }
  if (facts.length + constraints.length > MAX_QUERY_CLAUSES) {
    return rejected("query", `a query cannot contain more than ${MAX_QUERY_CLAUSES} clauses`);
  }

  const boundVariables = new Set<string>();
  for (const fact of facts) {
    collectVariables(fact.entity, boundVariables);
    collectVariables(fact.value, boundVariables);
  }

  for (const [index, constraint] of constraints.entries()) {
    for (const term of [constraint.left, constraint.right]) {
      if (term.kind === "wildcard") {
        return rejected(`query.constraints[${index}]`, "wildcards are not valid builtin arguments");
      }
      if (term.kind === "variable" && !boundVariables.has(term.name)) {
        return rejected(
          `query.constraints[${index}]`,
          `builtin variable ${term.name} must be bound by a fact relation`,
        );
      }
    }
  }

  const nonEmptyFacts = facts as NonEmptyReadonlyArray<FactClause>;
  return parsed(Object.freeze({
    facts: Object.freeze([...nonEmptyFacts]) as NonEmptyReadonlyArray<FactClause>,
    constraints: Object.freeze([...constraints]),
  }));
}

function collectVariables(term: Term, variables: Set<string>): void {
  if (term.kind === "variable") variables.add(term.name);
}
