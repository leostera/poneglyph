import assert from "node:assert/strict";
import type {FactInput} from "@leostera/poneglyph";
import type {Case} from "./small.js";
import {checkAllLookups} from "./small.js";
import type {Session} from "./session.js";
import {constant, equalBag, relation, variable, type Query} from "./model.js";
import {entityLeaf} from "./read-faults.js";
import {parseReply} from "./response-evidence.js";
import {correctnessBudgets} from "./contract.js";

function seedFacts(): FactInput[] {
  return Array.from({length: 16}, (_, i) => {
    const entity = `test:split-${i}`;
    return [
      {source: "agent:split", entity, field: "test:values", value: {type: "list" as const, value: [{type: "text" as const, value: "shared"}, {type: "text" as const, value: "shared"}, {type: "number" as const, value: String(i)}]}},
      {source: "agent:split", entity, field: "test:links", value: {type: "reference" as const, value: `test:split-${(i + 1) % 16}`}},
    ];
  }).flat();
}
const join: Query = {
  source: "test:links(Entity, Mid), test:values(Mid, Value)",
  atoms: [{field: "test:links", entity: variable("Entity"), value: variable("Mid")}, {field: "test:values", entity: variable("Mid"), value: variable("Value")}],
};
async function split(s: Session, prefix: string, stopAfterPages?: number) {
  const database = s.runtime.database;
  const url = new URL("https://control.internal/__e2e/split");
  url.searchParams.set("graph", s.graph); url.searchParams.set("prefix", prefix);
  if (stopAfterPages !== undefined) url.searchParams.set("stopAfterPages", String(stopAfterPages));
  const response = await database.fetch(url, {method: "POST", headers: {authorization: `Bearer ${s.runtime.token}`}, signal: AbortSignal.timeout(correctnessBudgets.requestMs)});
  const body = parseReply(await response.json());
  s.outcomes.push({control: "native-split", prefix, stopAfterPages, status: response.status, body, recordedAt: new Date().toISOString()});
  return {status: response.status, body};
}
async function healthy(s: Session) {
  await checkAllLookups(s); await s.query(join); await s.verify();
}
async function run(s: Session, strategy: "nested" | "interrupted-copy") {
  const seeds = seedFacts(); await s.write("split-seed", seeds);
  await healthy(s);
  const prefix = await entityLeaf(s, seeds[0]!.entity);
  if (strategy === "interrupted-copy") {
    const paused = await split(s, prefix, 1);
    assert.equal(paused.status, 503);
    assert.equal(paused.body["status"], "copy-interrupted-for-recovery-test");
    assert.equal(paused.body["copiedPages"], 1, "interruption must follow a real copied native page");
    assert.equal(typeof paused.body["migrationId"], "string");
    const read = await s.request({action: "query", query: relation("test:values").source});
    if (read.status === 200) {
      assert.ok(Array.isArray(read.body["rows"]));
      equalBag(read.body["rows"], s.model.query(relation("test:values")), "actual in-flight migration read must be complete");
    } else {
      assert.ok([423, 503].includes(read.status) && read.body["retryable"] === true, "in-flight migration must return explicit blocking, not partial success");
      assert.equal(read.body["rows"], undefined);
    }
  }
  const completed = await split(s, prefix);
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.ok(["split", "already-split"].includes(String(completed.body["status"])));
  const child = await entityLeaf(s, seeds[0]!.entity);
  assert.ok(child.startsWith(prefix) && child.length === prefix.length + 1, "real data must move to a physical child, not a vacuous split acknowledgment");
  await healthy(s);
  if (strategy === "nested") {
    const nested = await split(s, child);
    assert.equal(nested.status, 200, JSON.stringify(nested.body));
    const grandchild = await entityLeaf(s, seeds[0]!.entity);
    assert.ok(grandchild.startsWith(child) && grandchild.length === child.length + 1);
    await healthy(s);
  }
  await s.write("split-seed", seeds, 200, 2); // Old terminal identity survives migration.
  const changes: FactInput[] = seeds.filter(fact => fact.field === "test:values").slice(0, 2).flatMap(fact => [
    {...fact, retraction: true}, {...fact, value: {type: "text" as const, value: "post-migration"}},
  ]);
  await s.write("split-changes", changes);
  await healthy(s);
  // Fully bound old-value negative and new-value lookup after actual churn.
  await s.query({source: 'test:values("test:split-0", "shared")', atoms: [{field: "test:values", entity: constant("test:split-0"), value: constant("shared")}]});
}
export const splitCases: Case[] = (["nested", "interrupted-copy"] as const).map(strategy => ({
  name: `topology/${strategy}-exact-public-and-durable`, run: s => run(s, strategy),
}));
