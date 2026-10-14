import assert from "node:assert/strict";
import {test} from "node:test";
import type {FactInput} from "@leostera/poneglyph";
import {legalOrders, legalPrefixes} from "./legal-history.js";
import {Model, relation, equalBag} from "./model.js";
test("overlapping callers admit both orders, real-time predecessors cannot be reversed", () => {
  assert.deepEqual(legalOrders([{id: "a", invoked: 0, settled: 3}, {id: "b", invoked: 1, settled: 2}]), [["a", "b"], ["b", "a"]]);
  assert.deepEqual(legalOrders([{id: "a", invoked: 0, settled: 1}, {id: "b", invoked: 2, settled: 3}]), [["a", "b"]]);
  const four = Array.from({length: 4}, (_, i) => ({id: String(i), invoked: i, settled: 9 - i}));
  assert.equal(legalOrders(four).length, 24, "complete bounded permutations, not sampling");
  assert.equal(legalOrders([...four.slice(0, 2), {id: "later", invoked: 10, settled: 11}]).length, 2);
});
test("read prefixes include all preceding acknowledgments and no future invocation", () => {
  const operations = [{id: "a", invoked: 0, settled: 1}, {id: "b", invoked: 4, settled: 5}];
  assert.deepEqual(legalPrefixes(["a", "b"], operations, {invoked: 2, settled: 3}), [["a"]]);
  assert.deepEqual(legalPrefixes(["a", "b"], operations, {invoked: 6, settled: 7}), [["a", "b"]]);
  assert.throws(() => legalPrefixes(["unknown"], operations, {invoked: 2, settled: 3}));
});
test("invalid intervals/duplicates/unbounded histories fail, never reduce the search silently", () => {
  assert.throws(() => legalOrders([]));
  assert.throws(() => legalOrders(Array.from({length: 5}, (_, i) => ({id: String(i), invoked: i, settled: i + 10}))));
  assert.throws(() => legalOrders([{id: "same", invoked: 0, settled: 2}, {id: "same", invoked: 1, settled: 3}]));
  for (const invoked of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => legalOrders([{id: "a", invoked, settled: 4}]));
  assert.throws(() => legalOrders([{id: "a", invoked: 2, settled: 2}]));
});
const fact: FactInput = {source: "agent:a", entity: "test:e", field: "test:race", value: {type: "list", value: [{type: "text", value: "same"}, {type: "text", value: "same"}]}};
const binding = {Entity: {type: "string", value: "test:e"}, Value: {type: "string", value: "same"}};
test("hand-calculated assert/retract alternatives preserve complete duplicate multisets", () => {
  const assertFirst = new Model(); assertFirst.commit("tx:seed", [fact]); assertFirst.commit("tx:a", [fact]); assertFirst.commit("tx:b", [{...fact, retraction: true}]);
  const retractFirst = new Model(); retractFirst.commit("tx:seed", [fact]); retractFirst.commit("tx:b", [{...fact, retraction: true}]); retractFirst.commit("tx:a", [fact]);
  equalBag(assertFirst.query(relation("test:race")), [], "assert then retract");
  equalBag(retractFirst.query(relation("test:race")), [binding, binding], "retract then assert");
  assert.throws(() => equalBag([binding], retractFirst.query(relation("test:race")), "partial list publication"));
});
test("one source retraction does not remove the other source, but projection order remains meaningful", () => {
  const other = {...fact, source: "agent:b"}, first = new Model(), second = new Model();
  for (const model of [first, second]) model.commit("tx:seed", [fact, other]);
  first.commit("tx:retract", [{...fact, retraction: true}]); first.commit("tx:reassert", [other]);
  second.commit("tx:reassert", [other]); second.commit("tx:retract", [{...fact, retraction: true}]);
  equalBag(first.query(relation("test:race")), [binding, binding], "other source survives");
  equalBag(second.query(relation("test:race")), [binding, binding], "order does not erase source-qualified active membership");
  assert.equal(first.projections.get("test:e")?.size, 1); assert.equal(second.projections.get("test:e")?.size, 0);
  assert.notDeepEqual(first.projections, second.projections, "equal query counts cannot certify the ordered projection");
});
