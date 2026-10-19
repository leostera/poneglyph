import assert from "node:assert/strict";
import {test, vi} from "vitest";
import {RunControl, persistCompletion} from "./run-control.js";
import {archiveReport, parseArchivedRun, validateTraversal} from "./archive.js";
import {mkdtemp, readFile, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {gunzipSync} from "node:zlib";
import {Session} from "./session.js";
test("fail-fast drains the original caller without issuing another retry or fabricating abort", async () => {
  let release: (() => void) | undefined, entered: (() => void) | undefined;
  const started = new Promise<void>(resolve => {entered = resolve;});
  const gate = new Promise<void>(resolve => {release = resolve;});
  let requests = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {requests++; entered?.(); await gate; return Response.json({error: "busy", retryable: true}, {status: 503});});
  const session = new Session({graphId: "test", token: "test", endpoints: ["http://unit.test"], database: {fetch}, close: async () => {}}, "test");
  const pending = session.write("original", []).then(() => "unexpected", error => String(error));
  await started; const drained = session.drain(); release?.(); await drained;
  assert.match(await pending, /write tx:original/); assert.equal(requests, 1); assert.equal(session.model.transactions.size, 0);
  await assert.rejects(session.request({action: "write", txId: "tx:not-issued", facts: []}), /before issuing/);
  assert.equal(requests, 1);
});
// Frozen historical report format, not a runnable backend matrix.
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
test("terminal completion is persisted before the file-level archiver consumes it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conformance-terminal-"));
  try {
    const control = new RunControl(), body = report(control, actors.map(name => actor(name))), path = join(directory, "report.json");
    const save = () => writeFile(path, JSON.stringify(body));
    await save(); await assert.rejects(archiveReport(path), /unfinished run/);
    await persistCompletion(control, save); await archiveReport(path);
    const retained = JSON.parse(gunzipSync(await readFile(path + ".gz")).toString());
    assert.equal(retained.execution.status, "complete");
    const summary = JSON.parse(await readFile(join(directory, "summary.json"), "utf8"));
    assert.equal(summary.executedPhases, 44); assert.equal(summary.unexecutedPhases, 0);
  } finally {await rm(directory, {recursive: true, force: true});}
});
test("startup/build failure and full completion have distinct terminal evidence", () => {
  const build = new RunControl(); build.stop({implementation: "A", phase: "build"}, "build defect"); validateTraversal(report(build, []));
  const startup = new RunControl(); startup.stop({implementation: "A", phase: "startup"}, "runtime failed"); validateTraversal(report(startup, [actor("A", [])]));
  assert.throws(() => validateTraversal(report(new RunControl(), [])));
  const complete = new RunControl(); complete.complete(); validateTraversal(report(complete, actors.map(name => actor(name))));
  assert.throws(() => validateTraversal(report(complete, [actor("A")])));
  assert.throws(() => parseArchivedRun({cases: [1], implementations: []}));
});
test("single-implementation report format requires the canonical composition and exact failure prefix", () => {
  const complete = new RunControl(); complete.complete();
  const sole = (control: RunControl, rows: object[]) => parseArchivedRun({...report(control, rows), formatVersion: 2});
  validateTraversal(sole(complete, [actor("poneglyph")]));
  assert.throws(() => validateTraversal(sole(complete, actors.map(name => actor(name)))));
  assert.throws(() => validateTraversal(sole(complete, [actor("G")])));
  const stopped = new RunControl(); stopped.stop({implementation: "poneglyph", phase: "warm", caseName: "one"}, "defect");
  validateTraversal(sole(stopped, [actor("poneglyph", [row("one", "fail", "not-run")])]));
  assert.throws(() => validateTraversal(sole(stopped, [actor("poneglyph", [row("one", "fail", "not-run"), row("two", "pass", "not-run")])])));
});
test("single-implementation terminal report archives four phases without historical traversal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conformance-sole-terminal-"));
  try {
    const control = new RunControl(), body = parseArchivedRun({...report(control, [actor("poneglyph")]), formatVersion: 2});
    const path = join(directory, "report.json"), save = () => writeFile(path, JSON.stringify(body));
    await persistCompletion(control, save); await archiveReport(path);
    const summary = JSON.parse(await readFile(join(directory, "summary.json"), "utf8"));
    assert.deepEqual(summary.plannedImplementations, ["poneglyph"]); assert.equal(summary.executedPhases, 4); assert.equal(summary.unexecutedPhases, 0);
  } finally {await rm(directory, {recursive: true, force: true});}
});
