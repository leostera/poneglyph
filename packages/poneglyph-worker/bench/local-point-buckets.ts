import {createHash, randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {build} from "esbuild";
import {Log, LogLevel, Miniflare} from "miniflare";

const packageDirectory = resolve(import.meta.dirname, "..");
const runId = randomUUID();
const partitionCounts = [1, 2, 4, 8, 16, 32, 64, 128];
const stateDirectory = await mkdtemp(resolve(tmpdir(), "poneglyph-point-buckets-"));
const artifacts = resolve(packageDirectory, ".artifacts/local-point-buckets", runId);
await mkdir(artifacts, {recursive: true});
const plan = {runId, sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim(),
  localOnly: true, independentKeys: 128, partitionCounts, offeredConcurrency: 128,
  restartBetweenSeedAndRead: true, deadlineMs: 60_000, stateDirectory};
await writeFile(resolve(artifacts, "plan.json"), JSON.stringify(plan, null, 2) + "\n");

const digest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
const bundles = resolve(stateDirectory, "bundles");
await mkdir(bundles, {recursive: true});
const built = await build({absWorkingDir: packageDirectory, metafile: true,
  entryPoints: {service: "bench/local-point-bucket-service.ts", driver: "bench/local-point-bucket-operator.ts"},
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
  if (!response.ok) throw new Error(`Point bucket ${path} returned HTTP ${response.status}`);
  return body;
};
const phasesComplete = (result: unknown) => {
  const phases = typeof result === "object" && result !== null && "phases" in result && Array.isArray(result.phases)
    ? result.phases : [];
  return phases.length === partitionCounts.length && phases.every((phase, index) => typeof phase === "object" && phase !== null &&
    "partitionCount" in phase && phase.partitionCount === partitionCounts[index] &&
    "measurement" in phase && typeof phase.measurement === "object" && phase.measurement !== null &&
    "issued" in phase.measurement && phase.measurement.issued === 128 &&
    "completed" in phase.measurement && phase.measurement.completed === 128 &&
    "failed" in phase.measurement && phase.measurement.failed === 0 &&
    "observedMaxInFlight" in phase.measurement && phase.measurement.observedMaxInFlight === 128);
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
  const seedComplete = phasesComplete(seed), readsComplete = phasesComplete(reads);
  const report = {plan, completed: seedComplete && readsComplete, source: {
      operatorSha256: await digest(resolve(packageDirectory, "bench/local-point-bucket-operator.ts")),
      bucketDoSha256: await digest(resolve(packageDirectory, "bench/local-point-bucket-do.ts")),
      serviceBundleSha256: await digest(serviceBundle), driverBundleSha256: await digest(driverBundle),
      inputPaths: Object.keys(built.metafile.inputs).sort(),
    }, seed, reads,
    scope: "Local Miniflare/SQLite cold-actor restart profile for append-only, hash-partitioned key owners. Each key is linearizable within its bucket; no cross-bucket transactions or graph query/join semantics. No Cloudflare deployment or resource mutation."};
  await writeFile(resolve(artifacts, "report.json"), JSON.stringify(report, null, 2) + "\n");
  complete = seedComplete && readsComplete;
  console.log(JSON.stringify({runId, artifacts, completed: complete, seed, reads}));
} finally {
  await runtime?.dispose();
  if (complete) await rm(stateDirectory, {recursive: true, force: true});
  else console.error(JSON.stringify({event: "local-point-buckets-state-retained", runId, stateDirectory, artifacts}));
}
