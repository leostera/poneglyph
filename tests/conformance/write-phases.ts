import assert from "node:assert/strict";
import type {FactInput} from "@leostera/poneglyph";
import type {Case} from "./small.js";
import type {Session} from "./session.js";
import {equalBag, Model, relation, stable} from "./model.js";
import {entityLeaf} from "./read-faults.js";
import {parseBarrierStatus, type BarrierConfig, type BarrierStatus, type WritePhase} from "./worker/write-barrier.js";

type Reply = Awaited<ReturnType<Session["request"]>>;
type Observed<T> = {kind: "returned"; value: T} | {kind: "failed"; error: unknown};
async function observed<T>(s: Session, label: string, run: () => Promise<T>): Promise<Observed<T>> {
  s.outcomes.push({history: label, event: "invoked"});
  try {
    const value = await run();
    s.outcomes.push({history: label, event: "returned", value});
    return {kind: "returned", value};
  } catch (error) {
    s.outcomes.push({history: label, event: "failed", error: String(error)});
    return {kind: "failed", error};
  }
}
async function barrier(s: Session, prefix: string, action?: "arm" | "release" | "clear", config?: BarrierConfig): Promise<BarrierStatus> {
  const database = await s.runtime.mf.getWorker("database");
  const url = new URL("https://control.internal/__e2e/write-barrier");
  url.searchParams.set("graph", s.graph); url.searchParams.set("prefix", prefix);
  if (action) url.searchParams.set("action", action);
  const response = await database.fetch(url, {
    method: action ? "POST" : "GET", headers: {authorization: `Bearer ${s.runtime.token}`},
    ...(config ? {body: JSON.stringify(config)} : {}), signal: AbortSignal.timeout(2_000),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const status = parseBarrierStatus(await response.json());
  s.outcomes.push({control: "write-barrier", prefix, action, status});
  return status;
}
async function reached(s: Session, prefix: string, config: BarrierConfig) {
  // Observation polling is only for the causal barrier, never an implicit write
  // retry. Each control request is bounded; expired/rejected fixtures fail.
  for (let poll = 0; poll < 128; poll++) {
    const status = await barrier(s, prefix);
    assert.notEqual(status.state, "idle", "armed barrier cannot disappear");
    if (status.state !== "idle") assert.deepEqual(status.config, config);
    if (status.state === "waiting") return status;
    assert.equal(status.state, "armed", "phase must be an actual successful native request, not expiry/rejection");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("native write phase was not reached within the finite observation budget");
}
function seedFacts(): FactInput[] {
  return Array.from({length: 25}, (_, i) => ({source: "agent:phase", entity: `test:phase-${i}`, field: "test:phase", value: {type: "text", value: `old-${i}`}}));
}
async function participants(s: Session, seeds: readonly FactInput[]) {
  const first = seeds[0]!;
  const prefix = await entityLeaf(s, first.entity);
  for (const candidate of seeds.slice(1)) {
    if (await entityLeaf(s, candidate.entity) !== prefix) return {prefix, entities: [first.entity, candidate.entity]};
  }
  // A's fresh root is one physical participant but still uses prepare/commit.
  // B1+ must exercise a real distributed path, not their local atomic shortcut.
  assert.equal(prefix, "", "owner-partitioned implementation needs two actual participants");
  return {prefix, entities: [first.entity, seeds[1]!.entity]};
}
function assertAtomicRead(reply: Reply, before: Model, after: Model, phase: WritePhase) {
  if (reply.status !== 200) {
    assert.ok([409, 423, 503].includes(reply.status) && reply.body["retryable"] === true, `only explicit retryable read blocking is legal: ${JSON.stringify(reply)}`);
    assert.equal(reply.body["rows"], undefined);
    return;
  }
  const query = relation("test:phase");
  assert.ok(Array.isArray(reply.body["rows"]));
  const actual = reply.body["rows"].map(stable).sort();
  const old = before.query(query).map(stable).sort();
  // Prepared is not a commit decision. After application, a buffered read may
  // see old/new whole transaction or block, never a participant subset.
  if (phase === "prepared") equalBag(actual, old, "prepared write is not publicly visible");
  else assert.ok(stable(actual) === stable(old) || stable(actual) === stable(after.query(query).map(stable).sort()), "atomic public read cannot expose only one transaction participant");
}
async function runPhase(s: Session, phase: WritePhase) {
  const seeds = seedFacts();
  await s.write("phase-seed", seeds);
  const query = relation("test:phase"); await s.query(query);
  const placement = await participants(s, seeds);
  const facts: FactInput[] = placement.entities.map((entity, i) => ({source: "agent:phase", entity, field: "test:phase", value: {type: "text", value: `new-${i}`}}));
  const before = new Model(); before.commit("tx:phase-seed", seeds);
  const next = new Model(); next.commit("tx:phase-seed", seeds); next.commit("tx:phase-write", facts);
  const config: BarrierConfig = {phase, txId: "tx:phase-write"};
  await barrier(s, placement.prefix, "arm", config);
  const pending = observed(s, "original-write", () => s.write("phase-write", facts));
  let write: Observed<Reply>;
  try {
    await reached(s, placement.prefix, config);
    const read = await observed(s, "in-flight-query", () => s.request({action: "query", query: query.source}, 1, {timeoutMs: 2_000}));
    assert.equal(read.kind, "returned", "transport timeout is unknown, not proof of legal read blocking");
    if (read.kind === "returned") assertAtomicRead(read.value, before, next, phase);
    const released = await barrier(s, placement.prefix, "release");
    assert.ok(released.state === "released" && released.outcome === "released", "fixture must release explicitly before safety expiry");
  } finally {
    await barrier(s, placement.prefix, "clear");
    write = await pending; // Always drain and retain the original caller outcome.
  }
  if (write.kind === "failed") throw write.error;
  await s.query(query);
  await s.write("phase-write", facts, 200, 2); // Retained terminal replay cannot redeliver.
}
export const writePhaseCases: Case[] = (["prepared", "applied"] as const).map(phase => ({
  name: `write-phase/${phase}-atomic-public-read`, run: s => runPhase(s, phase),
}));
