import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {createHash} from "node:crypto";
import {buildConformance, implementations, ROOT} from "./build.js";
import {startLocal} from "./runtime.js";
import {restart, Session} from "./session.js";
import {checkAllLookups, smallCases} from "./small.js";
import {archiveReport} from "./archive.js";

// Tier-first: no larger tier is implemented/enabled until this shared matrix
// has been diagnosed, repaired across affected implementations and rerun.
const args = process.argv.slice(2);
assert.equal(args.length, 0, "small-tier gate runs ALL implementations; no silent selection/skips");
assert.ok(smallCases.length > 0); assert.equal(new Set(smallCases.map(test => test.name)).size, smallCases.length);
const id = new Date().toISOString().replaceAll(":", "-");
const output = resolve(ROOT, "results", id), artifacts = resolve(ROOT, ".artifacts", id);
await mkdir(output, {recursive: true});
const files = ["build.ts", "runtime.ts", "model.ts", "model.test.ts", "session.ts", "small.ts", "run.ts", "worker/application.ts", "worker/database.ts", "archive.ts", "package.json", "pnpm-lock.yaml"];
const suiteDigests = Object.fromEntries(await Promise.all(files.map(async path => [path, createHash("sha256").update(await readFile(resolve(ROOT, path))).digest("hex")])));
const report = {kind: "correctness-conformance", tier: "small-1-100", id,
  gitRevision: execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim(),
  gitStatus: execFileSync("git", ["status", "--short"], {encoding: "utf8"}),
  runtime: {node: process.version, miniflare: "5.20261006.1-alpha", compatibilityDate: "2026-10-06"},
  suiteDigests, cases: smallCases.map(test => test.name),
  limitations: ["Initial small-tier foundation; controlled internal phase faults/splits/concurrency history checker are not yet implemented", "Quiescent disk runtime restart, not abrupt process kill or elapsed retention evidence", "No throughput/latency/performance measurements or promotion decisions"],
  implementations: [] as unknown[],
};
let failures = 0;
async function save() {await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");}
for (const implementation of implementations) {
  const bundles = resolve(artifacts, implementation.name, "bundles"), persistence = resolve(artifacts, implementation.name, "persistence");
  const manifest = await buildConformance(implementation, bundles);
  const results: {name: string; warm: string; cold: string; error?: string; coldError?: string; graph: string; facts: number; outcomes: unknown[]}[] = [];
  report.implementations.push({manifest, persistence, results}); await save();
  let runtime = await startLocal("conformance", persistence, 4, undefined, bundles);
  const sessions: Session[] = [];
  try {
    for (const [index, test] of smallCases.entries()) {
      const session = new Session(runtime, `conformance-small-${index}`); sessions.push(session);
      const result = {name: test.name, warm: "not-run", cold: "not-run", graph: session.graph, facts: 0, outcomes: session.outcomes};
      results.push(result);
      try {
        await test.run(session); assert.ok(session.model.log.length <= 100, "small-tier fact envelope");
        await checkAllLookups(session); await session.verify(); result.warm = "pass";
      } catch (error) {result.warm = "fail"; Object.assign(result, {error: String(error)}); failures++;}
      result.facts = session.model.log.length;
      console.log(`${implementation.name} ${result.warm} ${test.name}`); await save();
    }
    runtime = await restart(runtime, persistence, bundles);
    for (const [index, original] of sessions.entries()) {
      // Keep the independent oracle/input history; never rebuild it from SQL.
      const coldOutcomes: unknown[] = [];
      try {
        for (const prior of [original, ...original.related]) {
          const cold = new Session(runtime, prior.graph, prior.model);
          cold.queries.push(...prior.queries);
          try {await checkAllLookups(cold); await cold.verify();}
          finally {coldOutcomes.push({graph: prior.graph, outcomes: cold.outcomes});}
        }
        results[index]!.cold = "pass";
      } catch (error) {results[index]!.cold = "fail"; results[index]!.coldError = String(error); failures++;}
      Object.assign(results[index]!, {coldOutcomes});
      console.log(`${implementation.name} cold-${results[index]!.cold} ${results[index]!.name}`); await save();
    }
  } finally {await runtime.mf.dispose(); await save();}
}
await archiveReport(resolve(output, "report.json"));
console.log(`Correctness report: ${resolve(output, "summary.json")}; ${failures} failed checks. Persistence retained: ${artifacts}`);
if (failures) process.exitCode = 1;
