import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { parseDatalogQuery } from "@leostera/poneglyph";
import { DATASET } from "../src/dataset.js";
import { QUERY_RUBRIC } from "../src/query-rubric.js";

const sampleEntity = '"wiki:onepiece:page:Monkey%20D.%20Luffy"';
function parse(query: string) {
  const result = parseDatalogQuery(query);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("published One Piece query contract", () => {
  it("uses get_schema for observations instead of publishing a static predicate inventory", () => {
    assert.equal("predicates" in DATASET, false);
    assert.equal("predicateFields" in QUERY_RUBRIC, false);
    assert.match(DATASET.schemaObservation, /not a schema/i);
    assert.match(QUERY_RUBRIC.dataScope, /get_schema/);
  });

  it("covers every binary-relation binding form for a valid URI predicate", () => {
    const shapes: ((field: string) => string)[] = [
      field => `${field}(${sampleEntity}, "value")`,
      field => `${field}(${sampleEntity}, Value)`,
      field => `${field}(Entity, "value")`,
      field => `${field}(Entity, Value)`,
      field => `${field}(_, _)`,
    ];
    for (const shape of shapes) parse(shape("wiki:example:predicate"));
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

  it("publishes the value-index access path and the complete read metrics contract", () => {
    assert.match(QUERY_RUBRIC.physicalOperators.join(" "), /value_key index.*exact typed-value predicates/i);
    assert.match(DATASET.resultContract, /distinct shards touched.*read leases/i);
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
