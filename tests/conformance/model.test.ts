import {test} from "vitest";
import assert from "node:assert/strict";
import {Model, equalBag, relation, scalar, normalizeValue, type Evidence} from "./model.js";
import {fact} from "./small.js";

function golden() {
  const model = new Model(); model.commit("tx", [fact("test:a", {type: "text", value: "hello"})]);
  const evidence: Evidence = {
    fact_log: [{fact_id: "f1", tx_id: "tx", tx_index: 0, source: "agent:one", entity: "test:a", field: "test:value", value_json: '{"type":"text","value":"hello"}', retraction: 0}],
    active_facts: [{fact_id: "f1", tx_id: "tx", source: "agent:one", entity: "test:a", field: "test:value", value_json: '{"type":"text","value":"hello"}'}],
    active_values: [{fact_id: "f1", tx_id: "tx", source: "agent:one", entity: "test:a", field: "test:value", value_index: 0, value_key: '{"type":"text","value":"hello"}', value_json: '{"type":"text","value":"hello"}', datalog_type: "string", datalog_value: "hello"}],
    entity_versions: [{entity: "test:a", fields_json: '{"test:value":{"type":"text","value":"hello"}}'}],
  };
  return {model, evidence};
}
test("hand-calculated single fact, public binding and durable evidence", () => {
  const {model, evidence} = golden(); model.verifyEvidence(evidence);
  assert.deepEqual(model.query(relation("test:value")), [{Entity: {type: "string", value: "test:a"}, Value: {type: "string", value: "hello"}}]);
});
test("hand-calculated duplicate list and source multiplicity", () => {
  const model = new Model(), value = {type: "list" as const, value: [{type: "text" as const, value: "x"}, {type: "text" as const, value: "x"}]};
  model.commit("tx", [fact("test:a", value), fact("test:a", value), fact("test:a", value, "test:value", "agent:two")]);
  assert.equal(model.log.length, 3); assert.equal(model.active.size, 2); assert.equal(model.query(relation("test:value")).length, 4);
  model.commit("retract", [fact("test:a", value, "test:value", "agent:one", true)]);
  assert.equal(model.active.size, 1); assert.equal(model.query(relation("test:value")).length, 2);
  assert.equal(model.projections.get("test:a")!.size, 0, "projection is ordered, not an aggregate active tuple view");
});
test("ordered retraction and retry preserve append-only membership", () => {
  const model = new Model(), f = fact("test:a", {type: "text", value: "x"});
  assert.equal(model.canCommit([{...f, retraction: true}, f]), false);
  model.commit("tx", [f, {...f, retraction: true}, f]); model.commit("tx", [f, {...f, retraction: true}, f]);
  assert.equal(model.log.length, 3); assert.equal(model.active.size, 1);
});
test("hand-calculated overlapping entity transactions permit two whole projections, not mixed fields", () => {
  const left = [fact("test:a", {type: "text", value: "left"}, "test:first"), fact("test:a", {type: "text", value: "left"}, "test:second")];
  const right = [fact("test:a", {type: "text", value: "right"}, "test:first"), fact("test:a", {type: "text", value: "right"}, "test:second")];
  const leftThenRight = new Model(), rightThenLeft = new Model();
  leftThenRight.commit("tx:left", left); leftThenRight.commit("tx:right", right);
  rightThenLeft.commit("tx:right", right); rightThenLeft.commit("tx:left", left);
  const expected = ["left", "right"].map(value => ({Entity: {type: "string", value: "test:a"}, Value: {type: "string", value}}));
  equalBag(leftThenRight.query(relation("test:first")), expected, "hand-calculated active evidence with right projection winner");
  equalBag(rightThenLeft.query(relation("test:first")), expected, "hand-calculated active evidence with left projection winner");
  assert.deepEqual(Object.fromEntries(leftThenRight.projections.get("test:a")!), {"test:first": {type: "text", value: "right"}, "test:second": {type: "text", value: "right"}});
  assert.deepEqual(Object.fromEntries(rightThenLeft.projections.get("test:a")!), {"test:first": {type: "text", value: "left"}, "test:second": {type: "text", value: "left"}});
  assert.equal(leftThenRight.active.size, 4); assert.equal(rightThenLeft.active.size, 4);
});
test("hand-calculated scalar encodings and Unicode canonical map ordering", () => {
  assert.deepEqual(scalar({type: "null"}), {type: "string", value: "null"});
  assert.deepEqual(scalar({type: "number", value: "-9223372036854775808"}), {type: "integer", value: "-9223372036854775808"});
  assert.deepEqual(scalar({type: "boolean", value: false}), {type: "string", value: "false"});
  assert.deepEqual(scalar({type: "list", value: [{type: "text", value: "x"}]}), {type: "string", value: '[{"type":"text","value":"x"}]'});
  assert.equal(JSON.stringify(normalizeValue({type: "map", value: {"😀": {type: "null"}, "\ue000": {type: "null"}}})), '{"type":"map","value":{"":{"type":"null"},"😀":{"type":"null"}}}');
});
const corruptions: [string, (e: Evidence) => void][] = [
  ["missing acknowledged fact", e => e.fact_log.pop()],
  ["duplicate durable fact", e => e.fact_log.push({...e.fact_log[0]!})],
  ["missing active assertion", e => e.active_facts.pop()],
  ["missing index row", e => e.active_values.pop()],
  ["wrong index type", e => {e.active_values[0]!["datalog_type"] = "integer";}],
  ["untyped false retraction", e => {e.fact_log[0]!["retraction"] = "";}],
  ["wrong canonical index key", e => {e.active_values[0]!["value_key"] = "{}";}],
  ["wrong projection", e => {e.entity_versions[0]!["fields_json"] = "{}";}],
  ["orphan active reference", e => {e.active_facts[0]!["fact_id"] = "missing";}],
];
for (const [name, mutate] of corruptions) test(`checker sensitivity: ${name}`, () => {
  const {model, evidence} = golden(); mutate(evidence); assert.throws(() => model.verifyEvidence(evidence));
});
test("checker sensitivity: truthy SQL retraction corruption is not boolean-coerced", () => {
  const {model, evidence} = golden();
  model.commit("retract", [fact("test:a", {type: "text", value: "hello"}, "test:value", "agent:one", true)]);
  evidence.fact_log.push({...evidence.fact_log[0]!, fact_id: "f2", tx_id: "retract", retraction: 1});
  evidence.active_facts = []; evidence.active_values = []; evidence.entity_versions = [];
  model.verifyEvidence(evidence);
  for (const flag of [2, -1, true, "1", null, undefined]) {
    evidence.fact_log[1]!["retraction"] = flag;
    assert.throws(() => model.verifyEvidence(evidence));
  }
});
test("public comparison catches omission, duplicate and changed type", () => {
  const expected = golden().model.query(relation("test:value"));
  assert.throws(() => equalBag([], expected, "missing"));
  assert.throws(() => equalBag([...expected, ...expected], expected, "duplicate"));
  assert.throws(() => equalBag([{Entity: expected[0]!["Entity"], Value: {type: "integer", value: "0"}}], expected, "type"));
});
