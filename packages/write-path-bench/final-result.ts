import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SCENARIOS } from "./scenarios.js";

// Retain the final measurements and audit evidence, not bulky raw trial state.
// Invoke only after all runtimes and verification ledgers have been closed.
export async function saveFinalResult(directory: string, artifacts: string) {
  const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
  delete manifest.artifacts;
  const summary = JSON.parse(await readFile(resolve(directory, "summary.json"), "utf8"));
  if (summary.status !== "complete") throw new Error("cannot finalize an unfinished run");
  const scenarios = [];
  for (const scenario of SCENARIOS.filter(s => manifest.selected.includes(s.name))) {
    const report = JSON.parse(await readFile(resolve(directory, `${scenario.name}.json`), "utf8"));
    delete report.journal;
    delete report.journalError;
    if (report.metrics) delete report.metrics.interval;
    scenarios.push(report);
  }
  const result = { kind: "final local write-path result", manifest, summary, scenarios,
    artifactRetention: "Final aggregate only; raw SQLite state, input snapshots, reference ledgers, journals, bundles and progress samples are not retained. Runtime console logs are managed separately. Corpus cache and source/dataset digests are retained." };
  await writeFile(resolve(directory, "final.json"), JSON.stringify(result, null, 2) + "\n");
  // Save successfully before removing either reports or raw verification state.
  for (const name of await readdir(directory)) {
    if (name !== "final.json") await rm(resolve(directory, name), { recursive: true });
  }
  await rm(artifacts, { recursive: true });
}
