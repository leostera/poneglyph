// Focused development regression, NOT the complete small-tier certification.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {createHash} from "node:crypto";
import {buildConformance, implementation, ROOT} from "./build.js";
import {startHosted} from "./process-runtime.js";
import {Session} from "./session.js";
import {concurrentHistoryCases} from "./concurrent-histories.js";
import {partialApplyCases} from "./partial-apply.js";
const focusedCases = [...concurrentHistoryCases, ...partialApplyCases];
import {checkAllLookups} from "./small.js";
import {auditAuthorities} from "./authority-audit.js";
import {RunControl, persistCompletion, type RunStage} from "./run-control.js";
assert.equal(process.argv.length, 2, "focused shared regression has no selection arguments");
const id = `focused-controls-${new Date().toISOString().replaceAll(":", "-")}`, output = resolve(ROOT, "results", id), artifacts = resolve(ROOT, ".artifacts", id);
await mkdir(output, {recursive: true});
const execution = new RunControl();
const files = ["run-focused.ts", "partial-apply.ts", "participant-stage.ts", "worker/apply-gate.ts", "run.ts", "run-control.ts", "build.ts", "runtime.ts", "process-runtime.ts", "process-host.ts", "session.ts", "model.ts", "query-catalogue.ts", "legal-history.ts", "concurrent-histories.ts", "authority-audit.ts", "owner-witness.ts", "package.json", "../../package.json", "../../bun.lock"];
const digests = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash("sha256").update(await readFile(resolve(ROOT, file))).digest("hex")])));
const report = {kind: "focused-conformance-regression", notCertification: true, tier: "small-1-100", id, execution, suiteDigests: digests,
  gitRevision: execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim(), cases: focusedCases.map(c => c.name), implementations: [] as unknown[]};
const save = () => writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
let stage: RunStage = {implementation: implementation.name, phase: "build"};
try {
  {
    execution.requireRunning(); stage = {implementation: implementation.name, phase: "build"};
    const bundles = resolve(artifacts, implementation.name, "bundles"), persistence = resolve(artifacts, implementation.name, "persistence"), manifest = await buildConformance(bundles);
    const results: {name: string; graph: string; warm: string; cold: string; outcomes: unknown[]; coldOutcomes?: unknown[]}[] = [];
    report.implementations.push({manifest, persistence, results}); await save();
    stage = {implementation: implementation.name, phase: "startup"}; let runtime = await startHosted("conformance", persistence, bundles);
    const sessions: Session[] = [];
    try {
      for (const [index, test] of focusedCases.entries()) {
        stage = {implementation: implementation.name, phase: "warm", caseName: test.name}; const s = new Session(runtime, `conformance-focused-${index}`); sessions.push(s);
        const result = {name: test.name, graph: s.graph, warm: "not-run", cold: "not-run", outcomes: s.outcomes}; results.push(result);
        try {await test.run(s); assert.ok(s.model.log.length <= 100); await auditAuthorities(s); await checkAllLookups(s); await s.verify(); result.warm = "pass";}
        catch (error) {result.warm = "fail"; execution.stop(stage, error); throw error;}
        finally {await save();}
        console.log(`${implementation.name} focused-warm-pass ${test.name}`);
      }
      stage = {implementation: implementation.name, phase: "restart"}; runtime = await runtime.restart();
      for (const [index, prior] of sessions.entries()) {
        stage = {implementation: implementation.name, phase: "cold", caseName: results[index]!.name}; const s = new Session(runtime, prior.graph, prior.model);
        s.inheritQueries(prior.queries); for (const [id, seq] of prior.acknowledgedSequences) s.acknowledgedSequences.set(id, seq);
        for (const id of prior.submittedTransactionIds) s.submittedTransactionIds.add(id); results[index]!.coldOutcomes = s.outcomes;
        try {await auditAuthorities(s); await checkAllLookups(s); await s.verify(); results[index]!.cold = "pass";}
        catch (error) {results[index]!.cold = "fail"; execution.stop(stage, error); throw error;}
        finally {await save();}
        console.log(`${implementation.name} focused-cold-pass ${results[index]!.name}`);
      }
    } finally {
      if (execution.status === "stopped") for (const s of sessions) await s.drain();
      try {await runtime.close();} catch (error) {execution.stop({implementation: implementation.name, phase: "cleanup"}, error); throw error;}
      finally {await save();}
    }
  }
  await persistCompletion(execution, save);
} catch (error) {execution.stop(stage, error); await save(); process.exitCode = 1; console.error(error);}
console.log(`Focused regression report: ${resolve(output, "report.json")}; not full-tier certification.`);
