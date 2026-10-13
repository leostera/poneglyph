import assert from "node:assert/strict";
import type {FactInput} from "@leostera/poneglyph";
import {checkAllLookups, type Case} from "./small.js";
import type {Session} from "./session.js";
import {entityLeaf} from "./read-faults.js";
import {barrier, reached, observed} from "./write-phases.js";
import {auditAuthorities} from "./authority-audit.js";
import {parseActorFingerprint} from "./actor-fingerprint.js";
import {correctnessBudgets} from "./contract.js";
async function actor(s: Session, prefix: string) {
  const url = new URL("https://control.internal/__e2e/lifecycle"); url.searchParams.set("graph", s.graph); url.searchParams.set("prefix", prefix);
  const response = await s.runtime.database.fetch(url, {headers: {authorization: `Bearer ${s.runtime.token}`}, signal: AbortSignal.timeout(correctnessBudgets.controlRequestMs)});
  assert.equal(response.status, 200); return parseActorFingerprint(await response.json());
}
async function kill(s: Session) {
  const crash = s.runtime.crashAndRestart;
  assert.equal(typeof crash, "function", "actual native process-group capability is mandatory, not a skipped fixture");
  if (!crash) throw new Error("native crash adapter missing");
  const evidence = await crash(); s.outcomes.push(evidence);
}
const seed: FactInput[] = [
  {source: "agent:a", entity: "test:a", field: "test:value", value: {type: "text", value: "before"}},
  {source: "agent:b", entity: "test:b", field: "test:value", value: {type: "list", value: [{type: "number", value: "7"}, {type: "number", value: "7"}]}},
];
async function acknowledged(s: Session) {
  const receipt = await s.write("crash-seed", seed), prefix = await entityLeaf(s, "test:a"), before = await actor(s, prefix);
  await kill(s);
  const after = await actor(s, prefix); assert.equal(after.objectId, before.objectId); assert.notEqual(after.incarnation, before.incarnation);
  await auditAuthorities(s); await checkAllLookups(s); await s.verify();
  const replay = await s.write("crash-seed", seed, 200, 1); assert.deepEqual(replay.body, receipt.body);
  await s.write("crash-churn", [{...seed[0]!, retraction: true}, {...seed[0]!, value: {type: "text", value: "after"}}]);
}
async function applied(s: Session) {
  await s.write("crash-seed", seed);
  const prefix = await entityLeaf(s, "test:a"), before = await actor(s, prefix);
  const facts: FactInput[] = [
    {...seed[0]!, field: "test:next", value: {type: "text", value: "irrevocable"}},
    {...seed[0]!, field: "test:links", value: {type: "list", value: [{type: "reference", value: "test:b"}, {type: "reference", value: "test:b"}]}},
  ];
  const config = {phase: "applied" as const, txId: "tx:crash-applied"};
  await barrier(s, prefix, "arm", config);
  const pending = observed(s, "crash-original-caller", () => s.write("crash-applied", facts));
  let interrupted: Awaited<typeof pending>;
  try {
    await reached(s, prefix, config); await kill(s);
  } finally {
    try {await barrier(s, prefix, "clear");}
    finally {interrupted = await pending;}
  }
  assert.equal(interrupted.kind, "failed", "killed in-flight caller remains unknown, never a fabricated acknowledgment/abort");
  const after = await actor(s, prefix); assert.equal(after.objectId, before.objectId); assert.notEqual(after.incarnation, before.incarnation);
  // The captured native apply is irrevocable. Replay only the original identity,
  // graph and payload; the original failed transport is retained separately.
  const terminal = await s.write("crash-applied", facts, 200, 2);
  s.outcomes.push({event: "unknown-operation-reconciled", txId: config.txId, originalCallerDelivery: "unknown",
    retainedDecision: "committed", deliveryEvidence: "subsequent-original-graph-identity-payload-replay", receipt: terminal.body});
  const replay = await s.write("crash-applied", facts, 200, 3); assert.deepEqual(replay.body, terminal.body);
  await auditAuthorities(s); await checkAllLookups(s); await s.verify();
}
export const crashCases: Case[] = [
  {name: "lifecycle/SIGKILL-process-group-after-ack", run: acknowledged},
  {name: "recovery/SIGKILL-process-group-after-native-apply", run: applied},
];
