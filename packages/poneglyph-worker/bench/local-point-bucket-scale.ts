import {createHash, randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {build} from "esbuild";
import {Log, LogLevel, Miniflare} from "miniflare";

const packageDirectory = resolve(import.meta.dirname, "..");
const runId = randomUUID();
const layouts = [
  {keyCount: 128, partitionCounts: [8, 16, 32, 64, 128]},
  {keyCount: 1024, partitionCounts: [8, 16, 32, 64, 128]},
];
const expectedPhases = layouts.flatMap(layout => layout.partitionCounts.map(partitionCount => ({keyCount: layout.keyCount, partitionCount})));
const stateDirectory = await mkdtemp(resolve(tmpdir(), "poneglyph-point-bucket-scale-"));
const artifacts = resolve(packageDirectory, ".artifacts/local-point-bucket-scale", runId);
await mkdir(artifacts, {recursive: true});
const plan = {runId, sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim(),
  localOnly: true, layouts, offeredConcurrency: 128, restartBetweenSeedAndRead: true,
  deadlineMs: 120_000, stateDirectory};
await writeFile(resolve(artifacts, "plan.json"), JSON.stringify(plan, null, 2) + "\n");

const digest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
const bundles = resolve(stateDirectory, "bundles");
await mkdir(bundles, {recursive: true});
const built = await build({absWorkingDir: packageDirectory, metafile: true,
  entryPoints: {service: "bench/local-point-bucket-service.ts", driver: "bench/local-point-bucket-scale-operator.ts"},
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
      LAYOUTS: {type: "json", value: layouts}, RUN_ID: {type: "json", value: runId},
    }}},
    {config: {name: "service", manifest: serviceManifest, compatibilityDate: "2026-10-13", compatibilityFlags: ["nodejs_compat"],
      exports: {LocalPointBucketDO: {type: "durable-object", storage: "sqlite"}}}},
  ]});
const invoke = async (runtime: Miniflare, path: "/seed" | "/read") => {
  const driver = await runtime.getWorker("driver");
  const response = await driver.fetch(`https://local.internal${path}`, {method: "POST"});
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(`Point bucket scale ${path} returned HTTP ${response.status}`);
  return body;
};
const phasesComplete = (input: unknown) => {
  const phases = typeof input === "object" && input !== null && "phases" in input && Array.isArray(input.phases)
    ? input.phases : [];
  return phases.length === expectedPhases.length && phases.every((phase, index) => typeof phase === "object" && phase !== null &&
    "keyCount" in phase && phase.keyCount === expectedPhases[index]!.keyCount &&
    "partitionCount" in phase && phase.partitionCount === expectedPhases[index]!.partitionCount &&
    "issued" in phase && phase.issued === expectedPhases[index]!.keyCount &&
    "completed" in phase && phase.completed === expectedPhases[index]!.keyCount &&
    "failed" in phase && phase.failed === 0 && "observedMaxInFlight" in phase && phase.observedMaxInFlight === 128);
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
      operatorSha256: await digest(resolve(packageDirectory, "bench/local-point-bucket-scale-operator.ts")),
      bucketDoSha256: await digest(resolve(packageDirectory, "bench/local-point-bucket-do.ts")),
      serviceBundleSha256: await digest(serviceBundle), driverBundleSha256: await digest(driverBundle),
      inputPaths: Object.keys(built.metafile.inputs).sort(),
    }, seed, reads,
    scope: "Local Miniflare/SQLite aggregate-key count and partition-count profile after actor/runtime restart. Append-only per-key facts, one query wave at 128 max in-flight, no graph-wide transactions, joins or cross-bucket snapshot. No Cloudflare deployment or resource mutation."};
  await writeFile(resolve(artifacts, "report.json"), JSON.stringify(report, null, 2) + "\n");
  complete = seedComplete && readsComplete;
  console.log(JSON.stringify({runId, artifacts, completed: complete, seed, reads}));
} finally {
  await runtime?.dispose();
  if (complete) await rm(stateDirectory, {recursive: true, force: true});
  else console.error(JSON.stringify({event: "local-point-bucket-scale-state-retained", runId, stateDirectory, artifacts}));
}
