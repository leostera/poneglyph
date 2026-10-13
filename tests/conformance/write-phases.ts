import assert from "node:assert/strict";
import type {FactInput} from "@leostera/poneglyph";
import type {Case} from "./small.js";
import type {Session} from "./session.js";
import {equalBag, Model, relation, stable} from "./model.js";
import {entityLeaf} from "./read-faults.js";
import {correctnessBudgets} from "./contract.js";
import {parseBarrierStatus, type BarrierConfig, type BarrierStatus, type WritePhase} from "./worker/write-barrier.js";

type Reply = Awaited<ReturnType<Session["request"]>>;
type Scenario = {kind: "read"; phase: WritePhase} | {kind: "duplicate"; payload: "same" | "different"; phase: "prepared"};
export type Observed<T> = {kind: "returned"; value: T} | {kind: "failed"; error: unknown};
export async function observed<T>(s: Session, label: string, run: () => Promise<T>): Promise<Observed<T>> {
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
export async function barrier(s: Session, prefix: string, action?: "arm" | "release" | "clear", config?: BarrierConfig): Promise<BarrierStatus> {
  const database = s.runtime.database;
  const url = new URL("https://control.internal/__e2e/write-barrier");
  url.searchParams.set("graph", s.graph); url.searchParams.set("prefix", prefix);
  if (action) url.searchParams.set("action", action);
  const response = await database.fetch(url, {
    method: action ? "POST" : "GET", headers: {authorization: `Bearer ${s.runtime.token}`},
    ...(config ? {body: JSON.stringify(config)} : {}), signal: AbortSignal.timeout(correctnessBudgets.controlRequestMs),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const status = parseBarrierStatus(await response.json());
  s.outcomes.push({control: "write-barrier", prefix, action, status});
  return status;
}
export async function reached(s: Session, prefix: string, config: BarrierConfig) {
  // Observation polling is only for the causal barrier, never an implicit write
  // retry. Each control request is bounded; expired/rejected fixtures fail.
  for (let poll = 0; poll < correctnessBudgets.phaseObservationPolls; poll++) {
    const status = await barrier(s, prefix);
    assert.notEqual(status.state, "idle", "armed barrier cannot disappear");
    if (status.state !== "idle") assert.deepEqual(status.config, config);
    if (status.state === "waiting") return status;
    assert.equal(status.state, "armed", "phase must be an actual successful native request, not expiry/rejection");
    await new Promise(resolve => setTimeout(resolve, correctnessBudgets.phaseObservationDelayMs));
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
function assertPeer(reply: Reply, original: Reply, payload: "same" | "different") {
  if (reply.status === 200) {
    assert.equal(payload, "same", "changed payload cannot share an admitted identity's receipt");
    assert.deepEqual(reply.body, original.body, "concurrent same-identity callers get the exact same terminal receipt");
    return;
  }
  if (reply.status === 409) {
    assert.equal(payload, "different", "identical payload is not an identity conflict");
    return;
  }
  assert.ok([423, 503].includes(reply.status) && reply.body["retryable"] === true, `unexpected concurrent caller result: ${JSON.stringify(reply)}`);
}
async function runPhase(s: Session, scenario: Scenario) {
  const {phase} = scenario;
  const seeds = seedFacts();
  await s.write("phase-seed", seeds);
  const query = relation("test:phase"); await s.query(query);
  const placement = await participants(s, seeds);
  const facts: FactInput[] = placement.entities.map((entity, i) => ({source: "agent:phase", entity, field: "test:phase", value: {type: "text", value: `new-${i}`}}));
  const before = new Model(); before.commit("tx:phase-seed", seeds);
  const next = new Model(); next.commit("tx:phase-seed", seeds); next.commit("tx:phase-write", facts);
  const config: BarrierConfig = {phase, txId: "tx:phase-write"};
  await barrier(s, placement.prefix, "arm", config);
  let originalReturned = false;
  const pending = observed(s, "original-write", () => s.write("phase-write", facts)).then(result => {originalReturned = true; return result;});
  let write: Observed<Reply>;
  let peer: Promise<Observed<Reply>> | undefined;
  let peerResult: Observed<Reply> | undefined;
  const peerFacts = scenario.kind === "duplicate" && scenario.payload === "different"
    ? facts.map(fact => ({...fact, value: {type: "text" as const, value: "different-payload"}})) : facts;
  try {
    await reached(s, placement.prefix, config);
    if (scenario.kind === "read") {
      const read = await observed(s, "in-flight-query", () => s.request({action: "query", query: query.source}, 1, {timeoutMs: correctnessBudgets.inFlightReadMs}));
      assert.equal(read.kind, "returned", "transport timeout is unknown, not proof of legal read blocking");
      if (read.kind === "returned") assertAtomicRead(read.value, before, next, phase);
    } else {
      assert.equal(originalReturned, false, "original invocation is still pending at the prepared barrier");
      peer = observed(s, `concurrent-${scenario.payload}-payload`, () => s.request({action: "write", txId: config.txId, facts: peerFacts}, 1));
      // The caller intervals overlap before an explicitly observed release;
      // server-side serial execution is legal and is not presumed parallel.
      await reached(s, placement.prefix, config);
      assert.equal(originalReturned, false, "overlapping caller cannot fabricate original acknowledgment");
    }
    const released = await barrier(s, placement.prefix, "release");
    assert.ok(released.state === "released" && released.outcome === "released", "fixture must release explicitly before safety expiry");
  } finally {
    try {await barrier(s, placement.prefix, "clear");}
    finally {
      write = await pending; // Drain every caller even if control cleanup fails.
      if (peer) peerResult = await peer;
    }
  }
  if (write.kind === "failed") throw write.error;
  if (scenario.kind === "duplicate") {
    assert.ok(peerResult, "concurrent invocation must have a retained outcome");
    if (peerResult.kind === "failed") throw peerResult.error;
    assertPeer(peerResult.value, write.value, scenario.payload);
    if (scenario.payload === "different") await s.write("phase-write", peerFacts, 409, 2);
  }
  await s.query(query);
  const replay = await s.write("phase-write", facts, 200, 2); // Retained terminal replay cannot redeliver.
  assert.deepEqual(replay.body, write.value.body, "post-history receipt is exactly retained");
}
export const writePhaseCases: Case[] = [
  ...(["prepared", "applied"] as const).map(phase => ({
    name: `write-phase/${phase}-atomic-public-read`, run: (s: Session) => runPhase(s, {kind: "read", phase}),
  })),
  ...(["same", "different"] as const).map(payload => ({
    name: `concurrent/${payload}-payload-admitted-identity`, run: (s: Session) => runPhase(s, {kind: "duplicate", phase: "prepared", payload}),
  })),
];
