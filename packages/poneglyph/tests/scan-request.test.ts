import {describe, expect, it} from "vitest";
import {parseScanRequest} from "../src/storage/protocol.js";
import {MAX_QUERY_VALUE_SET_SIZE} from "../src/storage/constants.js";

const base = {graphId: "example", shardPrefix: "0100", shardGeneration: 2, directoryEpoch: 3,
  field: "test:field", snapshotSeq: 8, leaseExpiresAtMs: 100};
const text = (value: string) => ({type: "string", value});
const integer = (value: string) => ({type: "integer", value});
const parse = (filter: Record<string, unknown>) => parseScanRequest({...base, ...filter});

describe("scan request refined filters", () => {
  it("parses an unfiltered scan", () => {
    expect(parse({})).toEqual({ok: true, value: {...base, kind: "all"}});
  });

  it("keeps entity-only, value-only, and conjunctive entity-plus-value scans distinct", () => {
    expect(parse({entity: text("test:entity")})).toEqual({ok: true, value: {...base, kind: "entity", entity: text("test:entity")}});
    expect(parse({entity: integer("7")})).toEqual({ok: true, value: {...base, kind: "entity", entity: integer("7")}});
    expect(parse({value: integer("7")})).toEqual({ok: true, value: {...base, kind: "value", value: integer("7")}});
    expect(parse({entity: text("test:entity"), value: integer("7")})).toEqual({ok: true, value: {
      ...base, kind: "entity-value", entity: text("test:entity"), value: integer("7"),
    }});
  });

  it("allows entity joins only when the bound input value is present", () => {
    expect(parse({value: text("category"), joinField: "test:target"})).toEqual({ok: true, value: {
      ...base, kind: "value", value: text("category"), joinField: "test:target",
    }});
    expect(parse({entity: text("test:entity"), value: text("category"), joinField: "test:target"})).toEqual({ok: true, value: {
      ...base, kind: "entity-value", entity: text("test:entity"), value: text("category"), joinField: "test:target",
    }});
    expect(parse({entity: text("test:entity"), joinField: "test:target"})).toEqual({ok: false, error: {
      path: "scan.joinField", message: "entity join requires a bound input value",
    }});
    expect(parse({values: [text("one")], joinField: "test:target"})).toEqual({ok: false, error: {
      path: "scan.joinField", message: "entity join requires a bound input value",
    }});
  });

  it("accepts only distinct non-empty value sets and preserves type distinctions", () => {
    expect(parse({values: [text("7"), integer("7")]})).toEqual({ok: true, value: {
      ...base, kind: "values", values: [text("7"), integer("7")],
    }});
    expect(parse({values: [text("same"), text("same")]})).toEqual({ok: false, error: {
      path: "scan.values[1]", message: "expected distinct values",
    }});
    expect(parse({values: []})).toEqual({ok: false, error: {
      path: "scan.values", message: `expected between 1 and ${MAX_QUERY_VALUE_SET_SIZE} values`,
    }});
  });

  it("preserves filter conflict and join validation precedence", () => {
    expect(parse({entity: text("test:e"), values: ["malformed"]})).toEqual({ok: false, error: {
      path: "scan.values", message: "value-set scans cannot include entity or single-value filters",
    }});
    expect(parse({value: text("bound"), values: [text("other")]})).toEqual({ok: false, error: {
      path: "scan.values", message: "value-set scans cannot include entity or single-value filters",
    }});
    expect(parse({entity: text("test:e"), joinField: "not a URI"})).toEqual({ok: false, error: {
      path: "scan.joinField", message: "expected an absolute URI with a scheme",
    }});
    expect(parse({value: "malformed", values: []})).toEqual({ok: false, error: {
      path: "scan.value", message: "expected a tagged Datalog value",
    }});
  });
});
