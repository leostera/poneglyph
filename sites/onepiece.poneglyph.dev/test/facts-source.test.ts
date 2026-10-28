import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { fieldLiteralPrefix, observedRelationFields, parseFactsSource, starterSource } from "../src/app/facts-source.js";

describe("facts editor source", () => {
  it("suggests only fields observed with reference values and detects field-literal prefixes", () => {
    assert.deepEqual(observedRelationFields([
      { field: "z:link", valueTags: ["reference"] },
      { field: "a:member_of", valueTags: ["text", "reference"] },
      { field: "b:name", valueTags: ["text"] },
      { field: "z:link", valueTags: ["reference"] },
    ]), ["a:member_of", "z:link"]);
    assert.equal(fieldLiteralPrefix('  { field: "onepiece:mem'), "onepiece:mem");
    assert.equal(fieldLiteralPrefix("{ field: 'wiki:link"), "wiki:link");
    assert.equal(fieldLiteralPrefix('{ entity: "onepiece:pirate'), undefined);
    assert.equal(fieldLiteralPrefix('{ field: "onepiece:name", value: "text'), undefined);
  });

  it("parses the starter module into typed drafts without evaluating it", () => {
    const parsed = parseFactsSource(starterSource("abc"), 25);
    assert.ok(parsed.ok);
    assert.equal(parsed.facts.length, 3);
    assert.deepEqual(parsed.facts[1]!.value, { type: "number", value: "1500000000" });
    assert.equal(parsed.facts[2]!.value.type, "reference");
    assert.ok(parsed.facts.every(fact => fact.retraction === false));
  });

  it("accepts comments, trailing commas, retractions and big integers as strings", () => {
    const parsed = parseFactsSource(`// c\nexport default [\n /* x ] */ { entity: "a:b", field: "c:d", value: { type: "number", value: "9223372036854775807" }, retract: true, },\n] satisfies Fact[]; // done`, 25);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.facts[0], { entity: "a:b", field: "c:d", value: { type: "number", value: "9223372036854775807" }, retraction: true });
  });

  it("rejects code, unsafe numbers, unknown keys, bad types and oversize transactions", () => {
    const fact = (body: string) => `export default [${body}] satisfies Fact[];`;
    for (const [source, message] of [
      ["const x = 1", /export default/],
      [fact(`{ entity: x, field: "c:d", value: { type: "text", value: "v" } }`), /plain values only/],
      [fact(`{ entity: "a:b", field: "c:d", value: { type: "number", value: 9007199254740993 } }`), /quote/],
      [fact(`{ entity: "a:b", field: "c:d", value: { type: "number", value: 1.5 } }`), /integers/],
      [fact(`{ entity: "a:b", field: "c:d", source: "forged", value: { type: "text", value: "v" } }`), /unknown key "source"/],
      [fact(`{ entity: "a:b", field: "c:d", value: { type: "list", value: [] } }`), /value.type/],
      [fact(`{ entity: "a:b", field: "c:d", value: { type: "boolean", value: "yes" } }`), /true or false/],
      [fact(""), /at least one/],
      [`export default [{ entity: "a:b", field: "c:d", value: { type: "text", value: "v" } }]; fetch("x")`, /satisfies/],
      [fact(Array.from({ length: 3 }, () => `{ entity: "a:b", field: "c:d", value: { type: "text", value: "v" } }`).join(",")), /At most 2/],
    ] as const) {
      const parsed = parseFactsSource(source, 2);
      assert.equal(parsed.ok, false, source);
      if (!parsed.ok) assert.match(parsed.error, message);
    }
  });
});
