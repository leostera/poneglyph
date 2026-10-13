import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {createHash} from "node:crypto";
import {buildConformance, implementations, ROOT} from "./build.js";
import {startHosted} from "./process-runtime.js";
import {Session} from "./session.js";
import {checkAllLookups, smallCases} from "./small.js";
import {archiveReport} from "./archive.js";
import {auditAuthorities} from "./authority-audit.js";
import {RunControl, persistCompletion, type RunStage} from "./run-control.js";
import {correctnessBudgets, requiredCoverage, smallTierComplete, statefulSeeds} from "./contract.js";

// Tier-first: no larger tier is implemented/enabled until this shared matrix
// has been diagnosed, repaired across affected implementations and rerun.
const args = process.argv.slice(2);
assert.equal(args.length, 0, "small-tier gate runs ALL implementations; no silent selection/skips");
assert.ok(smallCases.length > 0); assert.equal(new Set(smallCases.map(test => test.name)).size, smallCases.length);
const id = new Date().toISOString().replaceAll(":", "-");
const output = resolve(ROOT, "results", id), artifacts = resolve(ROOT, ".artifacts", id);
await mkdir(output, {recursive: true});
const files = ["contract.ts", "contract.test.ts", "build.ts", "build-identity.test.ts", "runtime.ts", "process-runtime.ts", "process-host.ts", "process-group.ts", "process-group.test.ts", "crashes.ts", "model.ts", "model.test.ts", "query-catalogue.ts", "query-catalogue.test.ts", "inspection-page.ts", "inspection-page.test.ts", "read-faults.ts", "read-fault.test.ts", "write-phases.ts", "concurrent-histories.ts", "legal-history.ts", "legal-history.test.ts", "splits.ts", "lifecycle.ts", "actor-fingerprint.ts", "actor-fingerprint.test.ts", "authority-audit.ts", "authority-evidence.ts", "authority-evidence.test.ts", "owner-witness.ts", "owner-witness.test.ts", "transaction-digest.ts", "transaction-digest.test.ts", "worker/authority-placement.ts", "worker/authority-sql.ts", "worker/authority-controls.ts", "write-barrier.test.ts", "response-evidence.ts", "response-evidence.test.ts", "session.ts", "small.ts", "run-control.ts", "run-control.test.ts", "run.ts", "worker/application.ts", "worker/database.ts", "worker/read-fault.ts", "worker/write-barrier.ts", "archive.ts", "package.json", "pnpm-lock.yaml"];
const suiteDigests = Object.fromEntries(await Promise.all(files.map(async path => [path, createHash("sha256").update(await readFile(resolve(ROOT, path))).digest("hex")])));
const execution = new RunControl();
const report = {execution, kind: "correctness-conformance", tier: "small-1-100", id,
  gitRevision: execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim(),
  gitStatus: execFileSync("git", ["status", "--short"], {encoding: "utf8"}),
  runtime: {node: process.version, miniflare: "5.20261006.1-alpha", compatibilityDate: "2026-10-06"},
  suiteDigests, cases: smallCases.map(test => test.name),
  contract: {correctnessBudgets, requiredCoverage, smallTierComplete, statefulSeeds, seedsExecuted: false},
  limitations: ["Initial small-tier foundation plus actual scan-response faults and prepared/applied reply barriers with atomic public reads; native nested/interrupted-copy split checks and overlapping admitted-identity histories; native actor abort/reconstruction after acknowledgment and held apply; broader write failures/process crash/stale-routing/general-history coverage remains incomplete", "Warm cases include actual SIGKILL host/workerd process-group crashes after acknowledgment and held native apply; cold phases remain quiescent disk restarts, not elapsed retention or natural idle eviction", "No throughput/latency/performance measurements or promotion decisions"],
  implementations: [] as unknown[],
};
let failures = 0;
async function save() {await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");}
let stage: RunStage = {implementation: "A", phase: "build"};
try {
for (const implementation of implementations) {
  execution.requireRunning(); stage = {implementation: implementation.name, phase: "build"};
  const bundles = resolve(artifacts, implementation.name, "bundles"), persistence = resolve(artifacts, implementation.name, "persistence");
  const manifest = await buildConformance(implementation, bundles);
  const results: {name: string; warm: string; cold: string; error?: string; coldError?: string; graph: string; facts: number; outcomes: unknown[]}[] = [];
  report.implementations.push({manifest, persistence, results}); await save();
  stage = {implementation: implementation.name, phase: "startup"};
  let runtime = await startHosted("conformance", persistence, bundles);
  const sessions: Session[] = [];
  try {
    for (const [index, test] of smallCases.entries()) {
      execution.requireRunning(); stage = {implementation: implementation.name, phase: "warm", caseName: test.name};
      const session = new Session(runtime, `conformance-small-${index}`); sessions.push(session);
      const result = {name: test.name, warm: "not-run", cold: "not-run", graph: session.graph, facts: 0, outcomes: session.outcomes};
      results.push(result);
      try {
        await test.run(session); assert.ok(session.model.log.length <= 100, "small-tier fact envelope");
        for (const scope of [session, ...session.related]) await auditAuthorities(scope);
        await checkAllLookups(session); await session.verify(); result.warm = "pass";
      } catch (error) {result.warm = "fail"; Object.assign(result, {error: String(error)}); execution.stop(stage, error);}
      result.facts = session.model.log.length;
      console.log(`${implementation.name} ${result.warm} ${test.name}`); await save();
      execution.requireRunning(); // No next case or cold phase after a failure.
    }
    stage = {implementation: implementation.name, phase: "restart"};
    runtime = await runtime.restart();
    for (const [index, original] of sessions.entries()) {
      execution.requireRunning(); stage = {implementation: implementation.name, phase: "cold", caseName: results[index]!.name};
      // Keep the independent oracle/input history; never rebuild it from SQL.
      const coldOutcomes: unknown[] = [];
      try {
        for (const prior of [original, ...original.related]) {
          const cold = new Session(runtime, prior.graph, prior.model);
          cold.inheritQueries(prior.queries);
          for (const [txId, sequence] of prior.acknowledgedSequences) cold.acknowledgedSequences.set(txId, sequence);
          for (const txId of prior.submittedTransactionIds) cold.submittedTransactionIds.add(txId);
          try {await auditAuthorities(cold); await checkAllLookups(cold); await cold.verify();}
          finally {coldOutcomes.push({graph: prior.graph, outcomes: cold.outcomes});}
        }
        results[index]!.cold = "pass";
      } catch (error) {results[index]!.cold = "fail"; results[index]!.coldError = String(error); execution.stop(stage, error);}
      Object.assign(results[index]!, {coldOutcomes});
      console.log(`${implementation.name} cold-${results[index]!.cold} ${results[index]!.name}`); await save();
      execution.requireRunning();
    }
  } finally {
    if (execution.status === "stopped") for (const [index, session] of sessions.entries()) {
      for (const scope of [session, ...session.related]) await scope.drain();
      results[index]!.facts = session.model.log.length;
    }
    try {await runtime.close();}
    catch (error) {execution.stop({implementation: implementation.name, phase: "cleanup"}, error); throw error;}
    finally {await save();}
  }
}
await persistCompletion(execution, save);
} catch (error) {execution.stop(stage, error); failures = 1; await save();}
await archiveReport(resolve(output, "report.json"));
console.log(`Correctness report: ${resolve(output, "summary.json")}; ${failures} failed checks. Persistence retained: ${artifacts}`);
if (failures) process.exitCode = 1;
