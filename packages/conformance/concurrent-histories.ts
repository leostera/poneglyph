import assert from "node:assert/strict";
import {isDeepStrictEqual} from "node:util";
import type {FactInput} from "@leostera/poneglyph";
import type {Case} from "./small.js";
import type {Session} from "./session.js";
import {Model, relation, stable, type Query} from "./model.js";
import {legalOrders, legalPrefixes, type Interval} from "./legal-history.js";
import {correctnessBudgets} from "./contract.js";
import {observed} from "./write-phases.js";
import {parseReply} from "./response-evidence.js";
type Operation = Readonly<{name: string; facts: readonly FactInput[]}>;
type Scenario = Readonly<{seed: readonly FactInput[]; operations: readonly [Operation, Operation]}>;
function expected(base: Model, operations: readonly Operation[], order: readonly string[]) {
  const model = new Model();
  for (const [id, facts] of base.transactions) model.commit(id, facts);
  for (const id of order) {const op = operations.find(op => `tx:${op.name}` === id); assert.ok(op); model.commit(id, op.facts);}
  return model;
}
const bag = (rows: readonly unknown[]) => rows.map(stable).sort();
async function write(s: Session, operation: Operation, app: number, clock: () => number, intervals: Interval[]) {
  const id = `tx:${operation.name}`, invoked = clock();
  try {
    let result = await s.request({action: "write", txId: id, facts: operation.facts}, app);
    for (let attempt = 1; result.status !== 200 && result.body["retryable"] === true && attempt < correctnessBudgets.writeAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, correctnessBudgets.retryBackoffMs));
      result = await s.request({action: "write", txId: id, facts: operation.facts}, app);
    }
    assert.equal(result.status, 200, "concurrent original identity settles, not admission/unknown");
    assert.equal(result.body["txId"], id); assert.equal(result.body["status"], "committed");
    const sequence = result.body["commitSeq"]; assert.ok(typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence > 0);
    s.acknowledgedSequences.set(id, sequence); return result;
  } finally {const trace = {id, invoked, settled: clock()}; intervals.push(trace); s.outcomes.push({event: "caller-history-settled", ...trace});}
}
async function publicRows(s: Session, query: Query, timeoutMs = correctnessBudgets.requestMs) {
  const result = await s.request({action: "query", query: query.source}, 2, {timeoutMs});
  assert.equal(result.status, 200); const rows = result.body["rows"]; assert.ok(Array.isArray(rows)); return rows;
}
async function run(s: Session, scenario: Scenario) {
  if (scenario.seed.length) await s.write("history-seed", scenario.seed);
  const query = relation("test:race"), intervals: Interval[] = []; let ordinal = 0; const clock = () => ordinal++;
  const writers = scenario.operations.map((op, app) => observed(s, `concurrent-${op.name}`, () => write(s, op, app, clock, intervals)));
  const invoked = clock();
  const read = await observed(s, "concurrent-buffered-read", () => s.request({action: "query", query: query.source}, 2, {timeoutMs: correctnessBudgets.inFlightReadMs}));
  const readInterval = {invoked, settled: clock()};
  if (read.kind === "failed") await s.drain(); // No new retries after a known unexpected read failure.
  const replies = await Promise.all(writers); // Drain every original caller, including a failed peer.
  if (read.kind === "failed") throw read.error;
  for (const reply of replies) if (reply.kind === "failed") throw reply.error;
  assert.equal(intervals.length, 2); assert.ok(intervals.every(op => op.invoked < Math.min(...intervals.map(other => other.settled))), "logical caller intervals really overlap");
  const orders = legalOrders(intervals), candidates = orders.map(order => ({order, model: expected(s.model, scenario.operations, order)}));
  s.outcomes.push({event: "legal-history-enumeration", intervals, readInterval, orders});
  if (read.value.status === 423) assert.equal(read.value.body["retryable"], true, "explicit legal blocking, never inferred from timeout");
  else {
    assert.equal(read.value.status, 200); const rows = read.value.body["rows"]; assert.ok(Array.isArray(rows));
    const prefixes = orders.flatMap(order => legalPrefixes(order, intervals, readInterval));
    assert.ok(prefixes.some(prefix => isDeepStrictEqual(bag(rows), bag(expected(s.model, scenario.operations, prefix).query(query)))), "buffered read must match a complete legal transaction-prefix multiset");
  }
  const actualRows = await publicRows(s, query), entities = [...new Set(scenario.operations.flatMap(op => op.facts.map(fact => fact.entity)))];
  const projections = new Map<string, unknown>();
  for (const entity of entities) {
    const result = await s.request({action: "entity", entity}, 3); assert.equal(result.status, 200);
    const value = result.body["entity"];
    if (value === null) projections.set(entity, null);
    else {const parsed = parseReply(value); projections.set(entity, {uri: parsed["uri"], fields: parsed["fields"]});}
  }
  const compatible = candidates.filter(({model}) => isDeepStrictEqual(bag(actualRows), bag(model.query(query))) && entities.every(entity => {
    const fields = model.projections.get(entity);
    const view = fields && fields.size ? {uri: entity, fields: Object.fromEntries(fields)} : null;
    return isDeepStrictEqual(projections.get(entity), view);
  }));
  assert.ok(compatible.length, "all final bindings AND projections must share one independently enumerated legal history");
  const selected = compatible[0]!; s.outcomes.push({event: "legal-history-matched", order: selected.order, compatibleOrders: compatible.map(c => c.order)});
  for (const id of selected.order) {const op = scenario.operations.find(op => `tx:${op.name}` === id); assert.ok(op); s.model.commit(id, op.facts);}
  s.inheritQueries([query]);
  for (const [app, op] of scenario.operations.entries()) {
    const replay = await s.write(op.name, op.facts, 200, app);
    const original = replies[app]!; assert.equal(original.kind, "returned");
    if (original.kind === "returned") assert.deepEqual(replay.body, original.value.body, "each concurrent identity retains its exact receipt without reapplication");
  }
}
const duplicates: FactInput = {source: "agent:a", entity: "test:e", field: "test:race", value: {type: "list", value: [{type: "text", value: "same"}, {type: "text", value: "same"}]}};
const scenarios: readonly [string, Scenario][] = [
  ["same-source-assert-retract", {seed: [duplicates], operations: [{name: "race-assert", facts: [duplicates]}, {name: "race-retract", facts: [{...duplicates, retraction: true}]}]}],
  ["source-qualified-retraction-projection", {seed: [duplicates, {...duplicates, source: "agent:b"}], operations: [{name: "race-retract-a", facts: [{...duplicates, retraction: true}]}, {name: "race-reassert-b", facts: [{...duplicates, source: "agent:b"}]}]}],
  ["disjoint-entities-typed-multiplicity", {seed: [], operations: [{name: "race-text", facts: [{...duplicates, entity: "test:a"}]}, {name: "race-integer", facts: [{...duplicates, entity: "test:b", value: {type: "list", value: [{type: "number", value: "7"}, {type: "number", value: "7"}]}}]}]}],
];
export const concurrentHistoryCases: Case[] = scenarios.map(([name, scenario]) => ({name: `concurrent/legal-history/${name}`, run: s => run(s, scenario)}));
