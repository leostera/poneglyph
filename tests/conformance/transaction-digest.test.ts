import assert from "node:assert/strict";
import {test} from "vitest";
import {transactionDigest} from "./transaction-digest.js";
import type {FactInput} from "@leostera/poneglyph";
const fact: FactInput = {source: "agent:a", entity: "test:a", field: "test:f", value: {type: "number", value: "01"}};
test("hand-calculated canonical retained wire identity", () => {
  // SHA256 of the literal golden envelope, including canonical int64 and false.
  assert.equal(transactionDigest("tx:golden", [fact]), "414390dd9de49a8aa830ecc3c90305dd01e769b07545caf1ae691a672bf5f333");
  assert.equal(transactionDigest("tx:golden", [fact]), transactionDigest("tx:golden", [{retraction: false, value: {value: "1", type: "number"}, field: "test:f", entity: "test:a", source: "agent:a"}]));
  for (const changed of [{...fact, source: "agent:b"}, {...fact, entity: "test:b"}, {...fact, field: "test:g"}, {...fact, retraction: true}, {...fact, value: {type: "text" as const, value: "1"}}]) assert.notEqual(transactionDigest("tx:golden", [changed]), transactionDigest("tx:golden", [fact]));
  assert.notEqual(transactionDigest("tx:other", [fact]), transactionDigest("tx:golden", [fact]));
  assert.notEqual(transactionDigest("tx:golden", [fact, fact]), transactionDigest("tx:golden", [fact]));
});
test("nested map ordering and wire property ordering normalize without dropping list multiplicity", () => {
  const one: FactInput = {...fact, value: {type: "map", value: {z: {type: "null"}, a: {type: "list", value: [{type: "number", value: "01"}, {type: "number", value: "1"}]}}}};
  const two: FactInput = {...fact, value: {type: "map", value: {a: {value: [{value: "1", type: "number"}, {value: "1", type: "number"}], type: "list"}, z: {type: "null"}}}};
  assert.equal(transactionDigest("tx:map", [one]), transactionDigest("tx:map", [two]));
  assert.notEqual(transactionDigest("tx:map", [one]), transactionDigest("tx:map", [{...one, value: {type: "map", value: {z: {type: "null"}, a: {type: "list", value: [{type: "number", value: "1"}]}}}}]));
});
