import assert from "node:assert/strict";
import type {FactInput} from "@leostera/poneglyph";
import type {Case} from "./small.js";
import {checkAllLookups} from "./small.js";
import type {Session} from "./session.js";
import {entityLeaf} from "./read-faults.js";
import {barrier, reached, observed, type Observed} from "./write-phases.js";
import {parseActorFingerprint, type ActorFingerprint} from "./actor-fingerprint.js";
import {parseReply} from "./response-evidence.js";
import {correctnessBudgets} from "./contract.js";

type Reply = Awaited<ReturnType<Session["request"]>>;
async function control(s: Session, prefix: string, action: "fingerprint" | "abort") {
  const database = await s.runtime.mf.getWorker("database");
  const url = new URL("https://control.internal/__e2e/lifecycle");
  url.searchParams.set("graph", s.graph); url.searchParams.set("prefix", prefix);
  const response = await database.fetch(url, {method: action === "abort" ? "POST" : "GET", headers: {authorization: `Bearer ${s.runtime.token}`}, signal: AbortSignal.timeout(correctnessBudgets.controlRequestMs)});
  const body = parseReply(await response.json());
  s.outcomes.push({control: "native-lifecycle", prefix, action, status: response.status, body, recordedAt: new Date().toISOString()});
  return {status: response.status, body};
}
async function fingerprint(s: Session, prefix: string) {
  const reply = await control(s, prefix, "fingerprint"); assert.equal(reply.status, 200);
  return parseActorFingerprint(reply.body);
}
async function reset(s: Session, prefix: string, before: ActorFingerprint) {
  const interrupted = await control(s, prefix, "abort");
  assert.equal(interrupted.status, 503, "runtime abort must interrupt its invoking RPC, not return normally");
  assert.equal(interrupted.body["action"], "native-abort");
  assert.equal(interrupted.body["requestInterrupted"], true);
  const after = await fingerprint(s, prefix);
  assert.equal(after.objectId, before.objectId, "same durable object identity must be reconstructed");
  assert.notEqual(after.incarnation, before.incarnation, "actual runtime reconstruction, not a caught exception/cache clear");
}
const seeds: FactInput[] = [
  {source: "agent:one", entity: "test:a", field: "test:alive", value: {type: "text", value: "same"}},
  {source: "agent:two", entity: "test:a", field: "test:alive", value: {type: "text", value: "same"}},
  {source: "agent:one", entity: "test:a", field: "test:count", value: {type: "number", value: "1"}},
  {source: "agent:one", entity: "test:b", field: "test:alive", value: {type: "boolean", value: true}},
];
async function afterAck(s: Session) {
  const original = await s.write("reset-seed", seeds);
  const prefix = await entityLeaf(s, "test:a"), before = await fingerprint(s, prefix);
  await reset(s, prefix, before);
  await checkAllLookups(s); await s.verify();
  const replay = await s.write("reset-seed", seeds, 200, 1);
  assert.deepEqual(replay.body, original.body, "reconstruction preserves the original terminal receipt");
  await s.write("reset-changes", [{...seeds[0]!, retraction: true}, {...seeds[0]!, value: {type: "text", value: "new"}}]);
  await checkAllLookups(s); await s.verify();
}
async function afterApply(s: Session) {
  await s.write("reset-seed", seeds);
  const prefix = await entityLeaf(s, "test:a"), before = await fingerprint(s, prefix);
  const facts: FactInput[] = [
    {source: "agent:one", entity: "test:a", field: "test:next", value: {type: "text", value: "applied"}},
    {source: "agent:one", entity: "test:a", field: "test:list", value: {type: "list", value: [{type: "text", value: "repeat"}, {type: "text", value: "repeat"}]}},
  ];
  const config = {phase: "applied" as const, txId: "tx:applied-write"};
  await barrier(s, prefix, "arm", config);
  const pending = observed(s, "apply-reset-original", () => s.write("applied-write", facts));
  let result: Observed<Reply>;
  try {
    const stage = await reached(s, prefix, config);
    assert.ok(["/_commit", "/_atomic"].includes(stage.path), "native local/distributed apply must actually finish before reset");
    await reset(s, prefix, before); // Runtime abort also interrupts the held native reply.
  } finally {
    try {await barrier(s, prefix, "clear");}
    finally {result = await pending;} // Drain even if cleanup fails; unknown is not abort.
  }
  if (result.kind === "failed") throw result.error;
  const replay = await s.write("applied-write", facts, 200, 2);
  assert.deepEqual(replay.body, result.value.body, "irrevocable apply recovers exactly one retained terminal receipt");
  await checkAllLookups(s); await s.verify();
}
export const lifecycleCases: Case[] = [
  {name: "lifecycle/native-actor-reset-after-ack", run: afterAck},
  {name: "recovery/native-actor-reset-after-apply-before-reply", run: afterApply},
];
