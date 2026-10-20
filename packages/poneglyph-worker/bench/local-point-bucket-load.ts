import {createHash, randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {build} from "esbuild";
import {Log, LogLevel, Miniflare} from "miniflare";

const packageDirectory = resolve(import.meta.dirname, "..");
const runId = randomUUID();
const partitionCounts = [8, 16, 32, 64, 128];
const loadLevels = [1_024, 512];
const stateDirectory = await mkdtemp(resolve(tmpdir(), "poneglyph-point-bucket-load-"));
const artifacts = resolve(packageDirectory, ".artifacts/local-point-bucket-load", runId);
await mkdir(artifacts, {recursive: true});
const plan = {runId, sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim(),
  localOnly: true, keyCount: 1_024, partitionCounts, loadLevels, restartBetweenSeedAndRead: true,
  deadlineMs: 120_000, stateDirectory};
await writeFile(resolve(artifacts, "plan.json"), JSON.stringify(plan, null, 2) + "\n");

const digest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
const bundles = resolve(stateDirectory, "bundles");
await mkdir(bundles, {recursive: true});
const built = await build({absWorkingDir: packageDirectory, metafile: true,
  entryPoints: {service: "bench/local-point-bucket-service.ts", driver: "bench/local-point-bucket-load-operator.ts"},
  outdir: bundles, outExtension: {".js": ".mjs"}, bundle: true, format: "esm", platform: "browser",
  target: "es2024", external: ["cloudflare:*", "node:*"], conditions: ["workerd", "worker", "browser"]});
const serviceBundle = resolve(bundles, "service.mjs"), driverBundle = resolve(bundles, "driver.mjs");
const manifest = async (path: string) => ({mainModule: "index.mjs", modules: {"index.mjs": {
  type: "esm" as const, contents: await readFile(path, "utf8"),
}}});
const serviceManifest = await manifest(serviceBundle), driverManifest = await manifest(driverBundle);
const createRuntime = () => new Miniflare({host: "127.0.0.1", port: 0,
  resourcePersistencePath: resolve(stateDirectory, "state"), telemetry: {enabled: false}, log: new Log(LogLevel.WARN),
  workers: [
    {config: {name: "driver", manifest: driverManifest, compatibilityDate: "2026-10-13", compatibilityFlags: ["nodejs_compat"], env: {
      BUCKETS: {type: "durable-object", worker: "service", exportName: "LocalPointBucketDO"},
      PARTITION_COUNTS: {type: "json", value: partitionCounts}, RUN_ID: {type: "json", value: runId},
    }}},
    {config: {name: "service", manifest: serviceManifest, compatibilityDate: "2026-10-13", compatibilityFlags: ["nodejs_compat"],
      exports: {LocalPointBucketDO: {type: "durable-object", storage: "sqlite"}}}},
  ]});
const invoke = async (runtime: Miniflare, path: "/seed" | "/read") => {
  const driver = await runtime.getWorker("driver");
  const response = await driver.fetch(`https://local.internal${path}`, {method: "POST"});
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(`Point bucket load ${path} returned HTTP ${response.status}`);
  return body;
};
const seedComplete = (input: unknown) => {
  const phases = typeof input === "object" && input !== null && "phases" in input && Array.isArray(input.phases)
    ? input.phases : [];
  return phases.length === partitionCounts.length && phases.every((phase, index) => typeof phase === "object" && phase !== null &&
    "partitionCount" in phase && phase.partitionCount === partitionCounts[index] &&
    "issued" in phase && phase.issued === 1_024 && "completed" in phase && phase.completed === 1_024 &&
    "failed" in phase && phase.failed === 0 && "observedMaxInFlight" in phase && phase.observedMaxInFlight === 128);
};
const readsComplete = (input: unknown) => {
  const phases = typeof input === "object" && input !== null && "phases" in input && Array.isArray(input.phases)
    ? input.phases : [];
  return phases.length === partitionCounts.length * loadLevels.length && phases.every((phase, index) => {
    const partitionIndex = Math.floor(index / loadLevels.length), loadIndex = index % loadLevels.length;
    return typeof phase === "object" && phase !== null &&
      "partitionCount" in phase && phase.partitionCount === partitionCounts[partitionIndex] &&
      "offeredConcurrency" in phase && phase.offeredConcurrency === loadLevels[loadIndex] &&
      "issued" in phase && phase.issued === 1_024 && "completed" in phase && phase.completed === 1_024 &&
      "failed" in phase && phase.failed === 0 && "observedMaxInFlight" in phase && phase.observedMaxInFlight === loadLevels[loadIndex];
  });
};

let complete = false, runtime: Miniflare | undefined;
try {
  runtime = createRuntime();
  await runtime.ready;
  const seed = await invoke(runtime, "/seed");
  await runtime.dispose();
  runtime = undefined;
  runtime = createRuntime();
  await runtime.ready;
  const reads = await invoke(runtime, "/read");
  const wroteAll = seedComplete(seed), readAll = readsComplete(reads);
  const report = {plan, completed: wroteAll && readAll, source: {
      operatorSha256: await digest(resolve(packageDirectory, "bench/local-point-bucket-load-operator.ts")),
      bucketDoSha256: await digest(resolve(packageDirectory, "bench/local-point-bucket-do.ts")),
      serviceBundleSha256: await digest(serviceBundle), driverBundleSha256: await digest(driverBundle),
      inputPaths: Object.keys(built.metafile.inputs).sort(),
    }, seed, reads,
    scope: "Local Miniflare/SQLite 1,024-key throughput and cold-restart profile across 8/16/32/64/128 append-only key buckets. Closed-loop concurrency waves, no Cloudflare deployment or resource mutation; no cross-bucket transactions or Datalog semantics."};
  await writeFile(resolve(artifacts, "report.json"), JSON.stringify(report, null, 2) + "\n");
  complete = wroteAll && readAll;
  console.log(JSON.stringify({runId, artifacts, completed: complete, seed, reads}));
} finally {
  await runtime?.dispose();
  if (complete) await rm(stateDirectory, {recursive: true, force: true});
  else console.error(JSON.stringify({event: "local-point-bucket-load-state-retained", runId, stateDirectory, artifacts}));
}
