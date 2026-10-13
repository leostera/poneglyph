import assert from "node:assert/strict";
import {test} from "node:test";
import {RunControl} from "./run-control.js";
import {parseArchivedRun, validateTraversal} from "./archive.js";
import {Session} from "./session.js";
test("fail-fast drains the original caller without issuing another retry or fabricating abort", async context => {
  let release: (() => void) | undefined, entered: (() => void) | undefined;
  const started = new Promise<void>(resolve => {entered = resolve;});
  const gate = new Promise<void>(resolve => {release = resolve;});
  let requests = 0;
  context.mock.method(globalThis, "fetch", async () => {requests++; entered?.(); await gate; return Response.json({error: "busy", retryable: true}, {status: 503});});
  const session = new Session({graphId: "test", token: "test", endpoints: ["http://unit.test"], database: {fetch}, close: async () => {}}, "test");
  const pending = session.write("original", []).then(() => "unexpected", error => String(error));
  await started; const drained = session.drain(); release?.(); await drained;
  assert.match(await pending, /write tx:original/); assert.equal(requests, 1); assert.equal(session.model.transactions.size, 0);
  await assert.rejects(session.request({action: "write", txId: "tx:not-issued", facts: []}), /before issuing/);
  assert.equal(requests, 1);
});
const actors = ["A", "B1", "C", "D", "E", "F", "G", "H", "I", "J", "K"];
const row = (name: string, warm = "pass", cold = "pass") => ({name, warm, cold, graph: "test", facts: 1});
function report(execution: object, implementations: object[]) {
  return parseArchivedRun({kind: "correctness-conformance", id: "test", tier: "small", gitRevision: "test", cases: ["one", "two"], execution, implementations});
}
const actor = (name: string, results = [row("one"), row("two")]) => ({manifest: {implementation: name}, persistence: "retained", results});
test("first failure prevents every subsequent stage and survives cleanup errors", () => {
  const control = new RunControl(); control.requireRunning();
  control.stop({implementation: "B1", phase: "warm", caseName: "one"}, new Error("original"));
  control.stop({implementation: "B1", phase: "cleanup"}, new Error("cleanup"));
  assert.equal(control.firstFailure?.error, "Error: original"); assert.equal(control.cleanupFailures.length, 1);
  assert.throws(() => control.requireRunning()); assert.throws(() => control.complete());
  const complete = new RunControl(); complete.complete(); assert.throws(() => complete.stop({implementation: "A", phase: "warm"}, "late"));
});
test("failed prefix archives explicitly unexecuted work, never a passing incomplete matrix", () => {
  const control = new RunControl(); control.stop({implementation: "B1", phase: "warm", caseName: "one"}, "defect");
  validateTraversal(report(control, [actor("A"), actor("B1", [row("one", "fail", "not-run")])]));
  assert.throws(() => validateTraversal(report(control, [actor("A"), actor("C", [row("one", "fail", "not-run")])])));
  assert.throws(() => validateTraversal(report(control, [actor("A"), actor("B1", [row("one", "fail", "not-run"), row("two", "pass", "not-run")])])));
  assert.throws(() => validateTraversal(report(control, [actor("A"), actor("B1", [row("one", "fail", "pass")])])));
  assert.throws(() => validateTraversal(report(control, [actor("A"), actor("B1", [row("one", "fail", "not-run"), row("two", "fail", "not-run")])])));
});
test("cold fail-fast retains warm coverage but cannot execute a later cold case", () => {
  const control = new RunControl(); control.stop({implementation: "A", phase: "cold", caseName: "one"}, "cold defect");
  validateTraversal(report(control, [actor("A", [row("one", "pass", "fail"), row("two", "pass", "not-run")])]));
  assert.throws(() => validateTraversal(report(control, [actor("A", [row("one", "pass", "fail"), row("two")])])));
});
test("startup/build failure and full completion have distinct terminal evidence", () => {
  const build = new RunControl(); build.stop({implementation: "A", phase: "build"}, "build defect"); validateTraversal(report(build, []));
  const startup = new RunControl(); startup.stop({implementation: "A", phase: "startup"}, "runtime failed"); validateTraversal(report(startup, [actor("A", [])]));
  assert.throws(() => validateTraversal(report(new RunControl(), [])));
  const complete = new RunControl(); complete.complete(); validateTraversal(report(complete, actors.map(name => actor(name))));
  assert.throws(() => validateTraversal(report(complete, [actor("A")])));
  assert.throws(() => parseArchivedRun({cases: [1], implementations: []}));
});
