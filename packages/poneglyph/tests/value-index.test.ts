import {describe, expect, it} from "vitest";
import type {FactValue} from "../src/domain/fact-value.js";
import {factScalarToDatalogValue, sameDatalogValue} from "../src/datalog/value.js";
import {parseFactValue} from "../src/domain/fact-value.js";
import {valueIndexKeysForDatalogValue} from "../src/storage/value-index.js";

const values: readonly FactValue[] = [
  {type: "null"},
  {type: "text", value: "shared"},
  {type: "number", value: "-9223372036854775808"},
  {type: "boolean", value: true},
  {type: "bytes", value: [0, 1, 255]},
  {type: "reference", value: "wiki:person:luffy"},
  {type: "date", value: "2024-02-29"},
  {type: "date_time", value: "2024-02-29T12:34:56Z"},
  {type: "list", value: [{type: "text", value: "nested"}, {type: "number", value: "7"}]},
  {type: "map", value: {nested: {type: "boolean", value: false}, title: {type: "text", value: "Luffy"}}},
];

describe("Datalog value index key inversion", () => {
  it("includes every canonical FactValue representation with the exact exposed typed value", () => {
    for (const factValue of values) {
      const datalogValue = factScalarToDatalogValue(factValue);
      const keys = valueIndexKeysForDatalogValue(datalogValue);
      expect(keys).toContain(JSON.stringify(factValue));
      expect(keys).toEqual([...new Set(keys)].sort());
      for (const key of keys) {
        const parsed = parseFactValue(JSON.parse(key));
        expect(parsed.ok).toBe(true);
        if (parsed.ok) expect(sameDatalogValue(factScalarToDatalogValue(parsed.value), datalogValue)).toBe(true);
      }
    }
  });

  it("preserves many-to-one string values and keeps strings disjoint from integers", () => {
    const shared = valueIndexKeysForDatalogValue({type: "string", value: "true"});
    expect(shared).toContain('{"type":"text","value":"true"}');
    expect(shared).toContain('{"type":"boolean","value":true}');

    const integer = valueIndexKeysForDatalogValue({type: "integer", value: "7"});
    expect(integer).toEqual(['{"type":"number","value":"7"}']);
    expect(integer).not.toContain('{"type":"text","value":"7"}');
  });
});
