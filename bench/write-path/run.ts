import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { randomUUID, createHash } from "node:crypto";
import { resolve, relative } from "node:path";
import { buildWorkers, ROOT } from "./build.js";
import { drive } from "./driver.js";
import { AuditLedger, corpusBatches, prepareReference } from "./ledger.js";
import { verifyStream } from "./stream-audit.js";
import { startLocal } from "./runtime.js";
import { SCENARIOS, integerOption } from "./scenarios.js";

async function saveJournal(journal: string, filename: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(journal)) digest.update(chunk);
  await pipeline(createReadStream(journal), createGzip(), createWriteStream(filename));
  return { file: filename.split("/").at(-1), uncompressedSha256: digest.digest("hex") };
}

async function main() {
  const selectedFacts = integerOption(process.env.BENCH_FACTS, 1_000_000, 2_000_000);
  const workerCount = integerOption(process.env.BENCH_WORKERS, 4, 32);
  const maxAttempts = integerOption(process.env.BENCH_ATTEMPTS, 8, 30);
  const timeout = integerOption(process.env.BENCH_TIMEOUT_MS, 30000, 120000);
  const selected = process.env.BENCH_SCENARIOS?.split(",") ?? SCENARIOS.map(s => s.name);
  if (selected.some(name => !SCENARIOS.some(s => s.name === name))) throw new Error("unknown scenario name");
  const runId = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const directory = resolve(ROOT, "results", runId);
  const artifacts = resolve(ROOT, ".data/runs", runId);
  await mkdir(directory, { recursive: true }); await mkdir(artifacts, { recursive: true });
  const build = await buildWorkers();
  const bundleDirectory = resolve(artifacts, "bundles");
  await mkdir(bundleDirectory);
  for (const name of ["application", "database"]) await copyFile(resolve(ROOT, `.build/${name}.mjs`), resolve(bundleDirectory, `${name}.mjs`));
  const corpus = JSON.parse(await readFile(resolve(ROOT, ".data/manifest.json"), "utf8"));
  const input = resolve(artifacts, "corpus.ndjson");
  await copyFile(resolve(ROOT, ".data/facts.ndjson"), input);
  const referencePath = resolve(artifacts, "reference.sqlite");
  console.log(`${runId}: preparing disk-backed verification for ${selectedFacts} facts`);
  const reference = await prepareReference(input, referencePath, selectedFacts);
  const manifest = { runId, version: "A-current-storage-unmodified", environment: "Miniflare; not cloud performance",
    build, corpus, reference, selectedFacts, scope: selectedFacts === corpus.facts ? "entire corpus" : selectedFacts >= 1_000_000 ? "approved million-fact corpus cap" : "diagnostic subset only",
    workerCount, retry: { maxAttempts, attemptTimeoutMs: timeout, backoff: "full jitter, exponential 100ms..5s" }, selected,
    artifacts: relative(ROOT, artifacts), policy: "Every planned batch is attempted; no batch shrinking, input skipping, storage fixes, outcome-limit changes, or fallback delivery" };
  await writeFile(resolve(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(resolve(directory, "summary.json"), JSON.stringify({ runId, status: "running", cloudGate: "closed" }, null, 2) + "\n");
  for (const name of ["application", "database"]) {
    await pipeline(createReadStream(resolve(bundleDirectory, `${name}.mjs`)), createGzip(), createWriteStream(resolve(directory, `${name}.mjs.gz`)));
  }
  let persistencePassed = true, fullWorkloadsCompleted = true;
  for (const scenario of SCENARIOS.filter(s => selected.includes(s.name))) {
    console.log(`${runId}: ${scenario.name}: ${selectedFacts} facts, concurrency ${scenario.concurrency}, ${workerCount} app Workers`);
    const report: Record<string, unknown> = { scenario, selectedFacts, plannedCalls: Math.ceil(selectedFacts / scenario.batchSize),
      startedAt: new Date().toISOString(), stage: "writing" };
    const reportPath = resolve(directory, `${scenario.name}.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    // Fresh persistence per trial; stable graph ID keeps entity hash placement comparable.
    const graphId = `bench-${scenario.name}`;
    const persistence = resolve(artifacts, scenario.name, "storage");
    const prefix = `bench:${runId}:${scenario.name}`;
    const ledger = new AuditLedger(resolve(artifacts, `${scenario.name}.ledger.sqlite`), referencePath, prefix, selectedFacts, scenario.batchSize);
    let runtime: Awaited<ReturnType<typeof startLocal>> | undefined;
    let progressWrite = Promise.resolve();
    try {
      runtime = await startLocal(graphId, persistence, workerCount, undefined, bundleDirectory);
      const result = await drive(corpusBatches(input, selectedFacts, scenario.batchSize, prefix), scenario,
        { endpoints: runtime.endpoints, token: runtime.token, maxAttempts, attemptTimeoutMs: timeout,
          journal: resolve(artifacts, `${scenario.name}.ndjson`), collectOutcomes: false, onOutcome: outcome => ledger.recordOutcome(outcome),
          onProgress: sample => {
            progressWrite = progressWrite.then(() => writeFile(resolve(directory, `${scenario.name}.progress.json`), JSON.stringify(sample, null, 2) + "\n"))
              .catch(error => { report.progressError = String(error); });
          } });
      await progressWrite;
      report.metrics = result.metrics; report.stage = "auditing";
      await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
      const drainStarted = performance.now();
      await runtime.waitForIdle();
      report.localDrainMs = performance.now() - drainStarted;
      report.audit = await verifyStream(runtime, ledger);
      const token = runtime.token;
      await runtime.mf.dispose(); runtime = undefined;
      runtime = await startLocal(graphId, persistence, workerCount, token, bundleDirectory);
      report.restartAudit = await verifyStream(runtime, ledger);
      report.persistenceChecksPassed = true;
      report.fullWorkloadCompleted = result.metrics.acknowledgedFacts === selectedFacts &&
        result.metrics.plannedCallsAttempted === Math.ceil(selectedFacts / scenario.batchSize);
      fullWorkloadsCompleted &&= report.fullWorkloadCompleted === true;
      report.stage = "complete";
      console.log(`${scenario.name}: ${result.metrics.acknowledgedFacts}/${selectedFacts} facts acknowledged; ${result.metrics.plannedCallsAttempted} calls attempted; persistence/restart audit passed`);
    } catch (error) {
      report.persistenceChecksPassed = false; report.stage = "failed"; report.error = error instanceof Error ? error.stack : String(error);
      persistencePassed = false; fullWorkloadsCompleted = false;
      console.error(`${scenario.name}: FAILED: ${String(error)}`);
    } finally {
      if (runtime) await runtime.mf.dispose();
      ledger.close();
      report.finishedAt = new Date().toISOString();
      try { report.journal = await saveJournal(resolve(artifacts, `${scenario.name}.ndjson`), resolve(directory, `${scenario.name}.outcomes.ndjson.gz`)); }
      catch (error) { report.journalError = String(error); }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    }
  }
  const summary = { runId, status: "complete", persistenceChecksPassed: persistencePassed, fullWorkloadsCompleted,
    cloudGate: persistencePassed && selectedFacts >= 1_000_000 && selected.length === SCENARIOS.length
      ? "full-input persistence gates passed; protocol/driver/deployment safety gates still required; failed loads are not throughput winners"
      : "closed: full-input persistence gates not met; no deployment performed",
    reportDirectory: relative(ROOT, directory) };
  await writeFile(resolve(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
  if (!persistencePassed) process.exitCode = 1;
}
await main();
