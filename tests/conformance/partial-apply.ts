import assert from "node:assert/strict";
import type {FactInput} from "@leostera/poneglyph";
import type {Case} from "./small.js";
import type {Session} from "./session.js";
import {entityLeaf} from "./read-faults.js";
import {parseReply} from "./response-evidence.js";
import {parseApplyGateStatus, type ApplyGateStatus} from "./worker/apply-gate.js";
import {parseParticipantStage} from "./participant-stage.js";
import {parseActorFingerprint} from "./actor-fingerprint.js";
import {transactionDigest} from "./transaction-digest.js";
import {normalizeValue, equalBag, relation} from "./model.js";
import {correctnessBudgets} from "./contract.js";
import {observed} from "./write-phases.js";
const txId = "tx:partial-write";
async function control(s: Session, prefix: string, kind: string, action?: string, body?: object) {
  const url = new URL(`https://control.internal/__e2e/${kind}`); url.searchParams.set("graph", s.graph); url.searchParams.set("prefix", prefix);
  if (action) url.searchParams.set("action", action); if (kind === "participant-stage") url.searchParams.set("txId", txId);
  const reply = await s.runtime.database.fetch(url, {method: action ? "POST" : "GET", headers: {authorization: `Bearer ${s.runtime.token}`}, ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(correctnessBudgets.controlRequestMs)});
  assert.equal(reply.status, 200); const value = await reply.json(); s.outcomes.push({control: kind, prefix, action, body: value}); return value;
}
async function gate(s: Session, prefix: string, action?: "arm" | "release" | "clear") {
  return parseApplyGateStatus(await control(s, prefix, "apply-gate", action, action === "arm" ? {txId} : undefined));
}
function active(status: ApplyGateStatus) {assert.ok(status.state === "armed" || status.state === "waiting", "no stale/expired gate can prove controlled partial apply");}
async function firstWaiting(s: Session, prefixes: readonly string[]) {
  for (let poll = 0; poll < correctnessBudgets.phaseObservationPolls; poll++) {
    for (const prefix of prefixes) {const status = await gate(s, prefix); active(status); if (status.state === "waiting") return prefix;}
    await new Promise(resolve => setTimeout(resolve, correctnessBudgets.phaseObservationDelayMs));
  }
  throw new Error("no actual native distributed commit request reached an armed gate");
}
async function committed(s: Session, prefix: string) {
  for (let poll = 0; poll < correctnessBudgets.phaseObservationPolls; poll++) {
    const stage = parseParticipantStage(await control(s, prefix, "participant-stage"), s.graph, prefix, txId);
    if (stage.status === "committed") return stage;
    assert.deepEqual(stage.facts, [], "prepared ledger cannot conceal applied rows");
    await new Promise(resolve => setTimeout(resolve, correctnessBudgets.phaseObservationDelayMs));
  }
  throw new Error("released native participant did not actually apply within the observation budget");
}
async function place(s: Session, seeds: readonly FactInput[]) {
  let first = await entityLeaf(s, seeds[0]!.entity);
  if (first === "") {
    const url = new URL("https://control.internal/__e2e/split"); url.searchParams.set("graph", s.graph); url.searchParams.set("prefix", "");
    const reply = await s.runtime.database.fetch(url, {method: "POST", headers: {authorization: `Bearer ${s.runtime.token}`}, signal: AbortSignal.timeout(correctnessBudgets.requestMs)});
    const body = parseReply(await reply.json()); s.outcomes.push({control: "partial-apply-native-split", status: reply.status, body});
    assert.equal(reply.status, 200); assert.equal(body["status"], "split"); first = await entityLeaf(s, seeds[0]!.entity); assert.equal(first.length, 1, "A must really move into a physical child");
  }
  for (const seed of seeds.slice(1)) {
    const second = await entityLeaf(s, seed.entity);
    if (second !== first) return [{prefix: first, entity: seeds[0]!.entity}, {prefix: second, entity: seed.entity}];
  }
  throw new Error("partial-application fixture requires two real physical participants");
}
async function run(s: Session) {
  const seeds: FactInput[] = Array.from({length: 25}, (_, i) => ({source: "agent:partial", entity: `test:partial-${i}`, field: "test:seed", value: {type: "text", value: "old"}}));
  await s.write("partial-seed", seeds); const targets = await place(s, seeds);
  const facts: FactInput[] = targets.flatMap(({entity}, i) => [
    {source: "agent:partial", entity, field: "test:partial", value: {type: "text", value: `new-${i}`}},
    {source: "agent:partial", entity, field: "test:partial", value: {type: "list", value: [{type: "number", value: String(i)}, {type: "number", value: String(i)}]}},
  ]);
  const fingerprints = await Promise.all(targets.map(async target => parseActorFingerprint(await control(s, target.prefix, "lifecycle"))));
  for (const target of targets) await gate(s, target.prefix, "arm");
  const pending = observed(s, "partial-original-caller", () => s.write("partial-write", facts));
  let killed = false;
  try {
    const applied = await firstWaiting(s, targets.map(t => t.prefix));
    const released = await gate(s, applied, "release"); assert.ok(released.state === "released" && released.outcome === "released");
    const peer = targets.find(target => target.prefix !== applied)!; await firstWaiting(s, [peer.prefix]);
    const first = await committed(s, applied);
    const second = parseParticipantStage(await control(s, peer.prefix, "participant-stage"), s.graph, peer.prefix, txId);
    const hash = transactionDigest(txId, facts); assert.equal(first.payloadHash, hash); assert.equal(second.payloadHash, hash);
    assert.equal(first.status, "committed"); assert.equal(second.status, "prepared"); assert.deepEqual(second.facts, [], "gated peer is not secretly applied");
    const entity = targets.find(target => target.prefix === applied)!.entity;
    const expected = facts.flatMap((fact, index) => fact.entity === entity ? [{index, source: fact.source, entity, field: fact.field, value: normalizeValue(fact.value), retraction: false}] : []);
    assert.equal(expected.length, 2); equalBag(first.facts, expected, "actual first-participant application is complete and exact");
    const read = await s.request({action: "query", query: relation("test:partial").source}, 1, {timeoutMs: correctnessBudgets.inFlightReadMs});
    if (read.status === 200) {assert.ok(Array.isArray(read.body["rows"])); equalBag(read.body["rows"], [], "a physically partial irrevocable commit is not a partial public success");}
    else assert.ok([409, 423, 503].includes(read.status) && read.body["retryable"] === true && read.body["rows"] === undefined, "explicit legal blocking, not timeout");
    const held = await gate(s, peer.prefix); assert.equal(held.state, "waiting");
    s.outcomes.push({event: "exact-native-partial-application", applied, prepared: peer.prefix, txId, payloadHash: hash, appliedFacts: first.facts});
    const crash = s.runtime.crashAndRestart; assert.ok(crash, "mandatory actual process-group crash capability");
    s.outcomes.push(await crash()); killed = true;
  } finally {
    try {for (const target of targets) await gate(s, target.prefix, "clear");}
    finally {const original = await pending; s.outcomes.push({event: "partial-original-drained", kind: original.kind}); if (killed) assert.equal(original.kind, "failed", "killed original caller retains unknown delivery");}
  }
  assert.ok(s.outcomes.some(value => {
    if (!value || typeof value !== "object" || Reflect.get(value, "status") !== "unknown") return false;
    const operation = Reflect.get(value, "operation");
    return operation && typeof operation === "object" && Reflect.get(operation, "txId") === txId;
  }), "original killed write must retain an actual uncertain transport outcome, not a known rejection");
  for (const [index, target] of targets.entries()) {
    const next = parseActorFingerprint(await control(s, target.prefix, "lifecycle")); assert.equal(next.objectId, fingerprints[index]!.objectId); assert.notEqual(next.incarnation, fingerprints[index]!.incarnation);
  }
  const recovered = await s.write("partial-write", facts, 200, 2), replay = await s.write("partial-write", facts, 200, 3);
  assert.deepEqual(replay.body, recovered.body); s.outcomes.push({event: "unknown-operation-reconciled", txId, originalCallerDelivery: "unknown", retainedDecision: "committed", receipt: recovered.body});
  await s.query(relation("test:partial"));
}
export const partialApplyCases: Case[] = [{name: "recovery/native-partial-participant-apply-process-crash", run}];
