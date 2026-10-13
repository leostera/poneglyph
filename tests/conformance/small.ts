import assert from "node:assert/strict";
import type {FactInput} from "@leostera/poneglyph";
import {constant, variable, relation, items, scalar, type Query, type Value} from "./model.js";
import {Session} from "./session.js";
import {readFaultCases} from "./read-faults.js";
import {writePhaseCases} from "./write-phases.js";
import {splitCases} from "./splits.js";
import {lifecycleCases} from "./lifecycle.js";
import {crashCases} from "./crashes.js";
import {concurrentHistoryCases} from "./concurrent-histories.js";
export type Case = {name: string; run: (session: Session) => Promise<void>};
export const fact = (entity: string, value: Value, field = "test:value", source = "agent:one", retraction = false): FactInput => ({source, entity, field, value, retraction});
const text = (value: string): Value => ({type: "text", value});
const values: [string, Value][] = [
  ["null", {type: "null"}], ["text-empty", text("")], ["text-unicode-escaped", text('海賊 🏴‍☠️\n"quoted"\\tail')],
  ["integer-min", {type: "number", value: "-9223372036854775808"}], ["integer-max", {type: "number", value: "9223372036854775807"}],
  ["integer-zero", {type: "number", value: "0"}], ["boolean-true", {type: "boolean", value: true}], ["boolean-false", {type: "boolean", value: false}],
  ["bytes", {type: "bytes", value: [0, 1, 127, 255]}], ["bytes-empty", {type: "bytes", value: []}],
  ["reference", {type: "reference", value: "test:target"}], ["date", {type: "date", value: "2024-02-29"}],
  ["date-time", {type: "date_time", value: "2024-02-29T23:59:59+09:00"}],
  ["list-empty", {type: "list", value: []}], ["list-duplicates", {type: "list", value: [text("repeat"), text("repeat"), {type: "number", value: "1"}]}],
  ["map-empty", {type: "map", value: {}}],
  ["nested-collections", {type: "list", value: [{type: "list", value: [text("inner")]}, {type: "map", value: {z: {type: "null"}, a: text("first")}}]}],
  ["map-unicode-order", {type: "map", value: {"😀": text("astral"), "\ue000": text("bmp"), a: {type: "list", value: [text("x"), {type: "boolean", value: true}]}}}],
];
export const smallCases: Case[] = [
  ...values.map(([name, value]) => ({name: `value/${name}`, async run(s: Session) {await s.write("typed", [fact("test:a", value), fact("test:b", value)]);}})),
  ...[1, 2, 10, 25, 50, 99, 100].map(size => ({name: `size/${size}`, async run(s: Session) {
    await s.write("batch", Array.from({length: size}, (_, i) => fact(`test:entity:${i}`, text(`value:${i % 7}`))));
  }})),
  {name: "identity/exact-replay", async run(s) {
    const facts = [fact("test:a", text("one")), fact("test:b", text("two"))];
    const first = await s.write("same", facts); const second = await s.write("same", facts, 200, 1);
    assert.deepEqual(second.body, first.body, "exact terminal replay");
  }},
  {name: "identity/changed-payload", async run(s) {
    await s.write("same", [fact("test:a", text("one"))]); await s.write("same", [fact("test:a", text("changed"))], 409, 1);
  }},
  {name: "identity/canonical-map-order", async run(s) {
    await s.write("same", [fact("test:a", {type: "map", value: {z: text("last"), a: text("first")}})]);
    await s.write("same", [fact("test:a", {type: "map", value: {a: text("first"), z: text("last")}})], 200, 1);
  }},
  {name: "identity/graph-isolation", async run(s) {
    await s.write("same", [fact("test:a", text("first graph"))]);
    const other = new Session(s.runtime, `${s.graph}-other`);
    s.related.push(other);
    await other.write("same", [fact("test:a", text("second graph"))]);
    await other.query(relation("test:value")); await other.verify();
    // The main graph's oracle never includes the second graph's evidence.
  }},
  {name: "assertion/duplicate-input", async run(s) {
    const f = fact("test:a", text("same")); await s.write("batch", [f, f, f]);
  }},
  {name: "assertion/multiple-sources", async run(s) {
    await s.write("batch", [fact("test:a", text("same")), fact("test:a", text("same"), "test:value", "agent:two")]);
  }},
  {name: "assertion/multiple-values", async run(s) {
    await s.write("first", [fact("test:a", text("old"))]); await s.write("second", [fact("test:a", text("new"))]);
  }},
  ...["assert-retract", "retract-assert", "assert-retract-assert", "source-qualified", "old-value-retraction"].map(order => ({name: `order/${order}`, async run(s: Session) {
    const f = fact("test:a", text("old")), retract = {...f, retraction: true};
    if (order === "assert-retract") await s.write("ordered", [f, retract]);
    if (order === "assert-retract-assert") await s.write("ordered", [f, retract, f]);
    if (order === "retract-assert") {await s.write("seed", [f]); await s.write("ordered", [retract, f]);}
    if (order === "source-qualified") {await s.write("seed", [f, {...f, source: "agent:two"}]); await s.write("ordered", [retract]);}
    if (order === "old-value-retraction") {await s.write("seed", [f, fact("test:a", text("new"))]); await s.write("ordered", [retract]);}
  }})),
  {name: "query/joins-cycles-repeated-variables", async run(s) {
    const edges = [fact("test:a", {type: "reference", value: "test:b"}, "test:edge"), fact("test:b", {type: "reference", value: "test:c"}, "test:edge"), fact("test:c", {type: "reference", value: "test:a"}, "test:edge"), fact("test:self", {type: "reference", value: "test:self"}, "test:edge")];
    await s.write("edges", edges);
    for (let length = 2; length <= 6; length++) {
      const atoms = Array.from({length}, (_, i) => ({field: "test:edge", entity: variable(`N${i}`), value: variable(`N${i + 1}`)}));
      await s.query({source: atoms.map((_, i) => `test:edge(N${i}, N${i + 1})`).join(", "), atoms});
    }
    await s.query({source: "test:edge(Node, Node)", atoms: [{field: "test:edge", entity: variable("Node"), value: variable("Node")}]});
  }},
  {name: "query/disconnected-and-constraints", async run(s) {
    await s.write("seed", [fact("test:a", text("prefix 海 suffix")), fact("test:b", text("other")), fact("test:a", {type: "number", value: "5"}, "test:age"), fact("test:b", {type: "number", value: "9"}, "test:age")]);
    const atoms = [{field: "test:value", entity: variable("Entity"), value: variable("Value")}];
    await s.query({source: 'test:value(Entity, Value), contains(Value, "海"), startsWith(Value, "prefix"), endsWith(Value, "suffix")', atoms, filter: row => row["Value"]!.value.includes("海") && row["Value"]!.value.startsWith("prefix") && row["Value"]!.value.endsWith("suffix")});
    await s.query({source: "test:age(Entity, Age), Age >= 6", atoms: [{field: "test:age", entity: variable("Entity"), value: variable("Age")}], filter: row => BigInt(row["Age"]!.value) >= 6n});
    await s.query({source: "test:value(Entity, Value), test:age(Other, Age)", atoms: [...atoms, {field: "test:age", entity: variable("Other"), value: variable("Age")}]});
  }},
  {name: "transport/lost-application-reply", async run(s) {
    const facts = [fact("test:a", text("committed")), fact("test:b", text("also committed"))];
    assert.equal((await s.request({action: "lost-write-reply", txId: "tx:lost", facts})).status, 502);
    await s.write("lost", facts, 200, 2);
  }},
  ...[0, 1, 2, 3].map(seed => ({name: `stateful/seed-${seed}`, async run(s: Session) {
    // Fixed bounded mixed histories; later tiers expand generator/shrinking.
    for (let i = 0; i < 12; i++) {
      const entity = `test:entity:${(i * 7 + seed) % 5}`, value = text(`v:${i % 3}`), field = `test:field:${i % 2}`;
      const f = fact(entity, value, field);
      await s.write(`tx:${i}`, [f]); if (i % 3 === 0) await s.write(`tx:${i}`, [f], 200, 1);
      if (i % 4 === 0) await s.write(`retract:${i}`, [{...f, retraction: true}]);
      await s.query(relation(field));
    }
  }})),
  ...[
    ["invalid-late-value", {txId: "tx:invalid", facts: [fact("test:a", text("must not persist")), fact("test:b", {type: "bytes", value: [256]})]}],
    ["invalid-int64", {txId: "tx:invalid", facts: [fact("test:a", {type: "number", value: "9223372036854775808"})]}],
    ["invalid-date", {txId: "tx:invalid", facts: [fact("test:a", {type: "date", value: "2023-02-29"})]}],
    ["empty-batch", {txId: "tx:invalid", facts: []}],
  ].map(([name, body]) => ({name: `boundary/${name}`, async run(s: Session) {
    const result = await s.request({action: "raw", path: "transactions", body}); assert.equal(result.status, 400);
    await s.query(relation("test:value"));
  }})),
  {name: "query/many-to-one-value-encodings", async run(s) {
    const values: Value[] = [
      {type: "null"}, text("null"), {type: "boolean", value: true}, text("true"),
      {type: "reference", value: "test:target"}, text("test:target"),
      {type: "number", value: "7"}, text("7"), {type: "date", value: "2024-02-29"}, text("2024-02-29"),
      {type: "bytes", value: []}, text("[]"), {type: "list", value: []},
    ];
    await s.write("collisions", values.map(value => fact("test:a", value)));
    // Same public encoding can come from different fact tags; integer/string
    // are still distinct. Common lookup checks must preserve all multiplicity.
  }},
  ...readFaultCases,
  ...writePhaseCases,
  ...splitCases,
  ...lifecycleCases,
  ...crashCases,
  ...concurrentHistoryCases,
];

export async function checkAllLookups(s: Session) {
  const fields = new Set(s.model.log.map(item => item.fact.field));
  for (const field of fields) {
    await s.query(relation(field));
    const assertions = [...s.model.active.values()].filter(item => item.fact.field === field);
    for (const entity of new Set(s.model.log.filter(item => item.fact.field === field).map(item => item.fact.entity))) await s.query(relation(field, entity));
    const bindings = new Map(assertions.flatMap(({fact}) => items(fact.value).map(item => {const binding = scalar(item); return [JSON.stringify(binding), binding] as const;})));
    for (const binding of bindings.values()) {
      const literal = binding.type === "integer" ? binding.value : JSON.stringify(binding.value);
      await s.query({source: `${field}(Entity, ${literal})`, atoms: [{field, entity: variable("Entity"), value: {constant: binding}}]});
      const entity = assertions[0]!.fact.entity;
      await s.query({source: `${field}(${JSON.stringify(entity)}, ${literal})`, atoms: [{field, entity: constant(entity), value: {constant: binding}}]});
    }
    await s.query(relation(field, "test:missing"));
  }
  await s.query(relation("test:missing-field"));
  const missing = await s.request({action: "entity", entity: "test:missing"}); assert.equal(missing.status, 200); assert.equal(missing.body["entity"], null);
}
