import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDatalogQuery } from "@leostera/poneglyph";
import { DATASET } from "../src/dataset.js";
import { QUERY_PREDICATE_INVENTORY, QUERY_RUBRIC } from "../src/query-rubric.js";

const sampleEntity = '"wiki:onepiece:page:Monkey%20D.%20Luffy"';
function parse(query: string) {
  const result = parseDatalogQuery(query);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("published One Piece query inventory", () => {
  it("lists each known corpus predicate and its Datalog value type exactly once", () => {
    const inventory = QUERY_RUBRIC.predicateFields.map(predicate => [predicate.field, predicate.valueType]).sort();
    const described = DATASET.predicates.map(predicate => [predicate.field, predicate.value === "text" ? "string" : "integer"]).sort();
    assert.deepEqual(inventory, described);
    assert.equal(new Set(inventory.map(([field]) => field)).size, 5);
  });

  it("covers every binary-relation binding form for each known predicate", () => {
    const shapes: ((field: string) => string)[] = [
      field => `${field}(${sampleEntity}, "value")`,
      field => `${field}(${sampleEntity}, Value)`,
      field => `${field}(Entity, "value")`,
      field => `${field}(Entity, Value)`,
      field => `${field}(_, _)`,
    ];
    for (const predicate of QUERY_PREDICATE_INVENTORY) {
      for (const shape of shapes) parse(shape(predicate.field));
    }
    assert.deepEqual(QUERY_RUBRIC.bindings.map(binding => binding.id), [
      "entity-and-value-constant",
      "entity-constant-value-variable",
      "entity-variable-value-constant",
      "both-variables",
      "wildcard-terms",
    ]);
  });

  it("accepts every documented builtin spelling with variables bound by facts", () => {
    for (const builtin of QUERY_RUBRIC.builtins) {
      for (const spelling of builtin.spellings) {
        const constraint = ["=", "<", "<=", ">", ">="].includes(spelling)
          ? `Name ${spelling} "Monkey D. Luffy"`
          : `${spelling}(Name, "Monkey")`;
        const query = parse(`wiki:page:title(${sampleEntity}, Name), ${constraint}`);
        assert.equal(query.facts.length, 1);
        assert.equal(query.constraints.length, 1);
      }
    }
  });

  it("keeps the documented boundary: positive facts required, builtins bind-only, no negation or unsupported calls", () => {
    assert.equal(parseDatalogQuery('contains("Monkey", "Mon")').ok, false);
    assert.equal(parseDatalogQuery('wiki:page:title(Page, Title), contains(Unknown, "Mon")').ok, false);
    assert.equal(parseDatalogQuery('!wiki:page:title(Page, Title)').ok, false);
    assert.equal(parseDatalogQuery('wiki:page:title(Page)').ok, false);
    assert.equal(parseDatalogQuery('wiki:page:title(Page, Title), matchesRegex(Title, ".*")').ok, false);
    assert.match(QUERY_RUBRIC.unsupported.join(" "), /negation.*disjunction.*recursive/i);
  });
});
