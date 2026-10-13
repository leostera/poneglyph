import assert from "node:assert/strict";
import {test} from "node:test";
import {QueryCatalogue} from "./query-catalogue.js";
import {relation, constant, variable, type Query} from "./model.js";
import {Session} from "./session.js";
test("only identical unfiltered replay specifications are deduplicated", () => {
  const catalogue = new QueryCatalogue(); catalogue.remember(relation("test:value")); catalogue.remember(relation("test:value"));
  assert.equal(catalogue.queries.length, 1);
  catalogue.remember(relation("test:value", "test:e")); assert.equal(catalogue.queries.length, 2);
  const sameSource: Query = {source: "test:value(Entity, Value)", atoms: [{field: "test:value", entity: variable("Entity"), value: constant("typed-constant")}]};
  catalogue.remember(sameSource); assert.equal(catalogue.queries.length, 3, "source equality cannot erase independent oracle specifications");
  catalogue.remember({...sameSource, atoms: [{...sameSource.atoms[0]!, value: {constant: {type: "integer", value: "7"}}}]});
  catalogue.remember({...sameSource, atoms: [{...sameSource.atoms[0]!, value: {constant: {type: "string", value: "7"}}}]});
  assert.equal(catalogue.queries.length, 5, "typed constants remain distinct");
});
test("opaque filters and external mutation cannot weaken the replay catalogue", () => {
  const catalogue = new QueryCatalogue(), query = relation("test:value"), predicate = () => true;
  catalogue.remember({...query, filter: predicate}); catalogue.remember({...query, filter: predicate});
  assert.equal(catalogue.queries.length, 2, "predicate closures are not assumed equivalent");
  catalogue.remember(query); query.atoms[0]!.field = "test:changed";
  const snapshot = catalogue.queries; snapshot[2]!.atoms[0]!.field = "test:external";
  assert.equal(catalogue.queries[2]!.atoms[0]!.field, "test:value");
  const cold = new QueryCatalogue(); cold.inherit(catalogue.queries); cold.remember(relation("test:value"));
  assert.equal(cold.queries.length, 3, "cold inheritance deduplicates only unfiltered repetitions");
});
test("explicit public reads still execute and compare at each changed state", async context => {
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => Response.json({rows: [{Entity: {type: "string", value: "test:e"}, Value: {type: "string", value: ++calls === 1 ? "before" : "after"}}]}));
  const runtime = {graphId: "test", token: "test", endpoints: ["http://unit.test"], database: {fetch}, close: async () => {}};
  const session = new Session(runtime, "test"), query = relation("test:value");
  const fact = {source: "agent:a", entity: "test:e", field: "test:value", value: {type: "text" as const, value: "before"}};
  session.model.commit("tx:before", [fact]); await session.query(query);
  session.model.commit("tx:after", [{...fact, retraction: true}, {...fact, value: {type: "text", value: "after"}}]); await session.query(relation("test:value"));
  assert.equal(calls, 2, "not a response cache or skipped state checkpoint"); assert.equal(session.queries.length, 1);
  const cold = new Session(runtime, "test", session.model); cold.inheritQueries(session.queries);
  for (const remembered of cold.queries) await cold.query(remembered, false);
  assert.equal(calls, 3, "cold performs a fresh public request and current-state comparison");
});
