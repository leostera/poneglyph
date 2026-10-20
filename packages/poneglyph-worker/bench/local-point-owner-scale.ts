import {createHash, randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {build} from "esbuild";
import {Log, LogLevel, Miniflare} from "miniflare";

const packageDirectory = resolve(import.meta.dirname, "..");
const runId = randomUUID();
const countLevels = [128, 512, 1024];
const stateDirectory = await mkdtemp(resolve(tmpdir(), "poneglyph-point-owner-scale-"));
const artifacts = resolve(packageDirectory, ".artifacts/local-point-owner-scale", runId);
await mkdir(artifacts, {recursive: true});
const plan = {runId, sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim(),
  localOnly: true, keyCounts: countLevels, maxInFlight: 128, restartsBetweenWriteAndRead: 1,
  deadlineMs: 60_000, stateDirectory};
await writeFile(resolve(artifacts, "plan.json"), JSON.stringify(plan, null, 2) + "\n");

const digest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
const bundles = resolve(stateDirectory, "bundles");
await mkdir(bundles, {recursive: true});
const built = await build({absWorkingDir: packageDirectory, metafile: true,
  entryPoints: {service: "bench/local-point-owner-scale-service.ts", driver: "bench/local-point-owner-scale-operator.ts"},
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
      POINT_OWNERS: {type: "durable-object", worker: "service", exportName: "LocalPointOwnerDO"},
      COUNT_LEVELS: {type: "json", value: countLevels}, RUN_ID: {type: "json", value: runId},
    }}},
    {config: {name: "service", manifest: serviceManifest, compatibilityDate: "2026-10-13", compatibilityFlags: ["nodejs_compat"],
      exports: {LocalPointOwnerDO: {type: "durable-object", storage: "sqlite"}}}},
  ]});
const invoke = async (runtime: Miniflare, path: "/seed" | "/read") => {
  const driver = await runtime.getWorker("driver");
  const response = await driver.fetch(`https://local.internal${path}`, {method: "POST"});
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(`Point-owner ${path} returned HTTP ${response.status}`);
  return body;
};
const levelsComplete = (result: unknown, operation: "writes" | "reads") => {
  const phases = typeof result === "object" && result !== null && "phases" in result && Array.isArray(result.phases)
    ? result.phases : [];
  return phases.length === countLevels.length && phases.every((phase, index) => typeof phase === "object" && phase !== null &&
    "keyCount" in phase && phase.keyCount === countLevels[index] && operation in phase &&
    typeof phase[operation] === "object" && phase[operation] !== null &&
    "issued" in phase[operation] && phase[operation].issued === countLevels[index] &&
    "completed" in phase[operation] && phase[operation].completed === countLevels[index] &&
    "failed" in phase[operation] && phase[operation].failed === 0 &&
    "observedMaxInFlight" in phase[operation] && phase[operation].observedMaxInFlight === 128);
};

let complete = false;
let runtime: Miniflare | undefined;
try {
  runtime = createRuntime();
  await runtime.ready;
  const seed = await invoke(runtime, "/seed");
  await runtime.dispose();
  runtime = undefined;

  // Reopen the same durable SQLite state so read requests must recover owner
  // identity/history after runtime/actor instances have been discarded.
  runtime = createRuntime();
  await runtime.ready;
  const reads = await invoke(runtime, "/read");
  const seedComplete = levelsComplete(seed, "writes");
  const readsComplete = levelsComplete(reads, "reads");
  const report = {plan, completed: seedComplete && readsComplete, source: {
      operatorSha256: await digest(resolve(packageDirectory, "bench/local-point-owner-scale-operator.ts")),
      pointOwnerDoSha256: await digest(resolve(packageDirectory, "bench/local-point-owner-do.ts")),
      serviceBundleSha256: await digest(serviceBundle), driverBundleSha256: await digest(driverBundle),
      inputPaths: Object.keys(built.metafile.inputs).sort(),
    }, seed, reads,
    scope: "Local Miniflare/SQLite key-count scale and actor-restart-read profile for a benchmark-only append-only point-owner Durable Object. Per-key serializable history; no graph-wide transactions, joins or cross-key snapshot. No Cloudflare deployment or resource mutation."};
  await writeFile(resolve(artifacts, "report.json"), JSON.stringify(report, null, 2) + "\n");
  complete = seedComplete && readsComplete;
  console.log(JSON.stringify({runId, artifacts, completed: complete, seed, reads}));
} finally {
  await runtime?.dispose();
  if (complete) await rm(stateDirectory, {recursive: true, force: true});
  else console.error(JSON.stringify({event: "local-point-owner-scale-state-retained", runId, stateDirectory, artifacts}));
}
