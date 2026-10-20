import {createHash, randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {build} from "esbuild";
import {Log, LogLevel, Miniflare} from "miniflare";

const packageDirectory = resolve(import.meta.dirname, "..");
const runId = randomUUID();
const stateDirectory = await mkdtemp(resolve(tmpdir(), "poneglyph-point-bucket-large-"));
const artifacts = resolve(packageDirectory, ".artifacts/local-point-bucket-large", runId);
await mkdir(artifacts, {recursive: true});
const plan = {runId, sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim(),
  localOnly: true, keyCount: 16_384, bucketCount: 32, seedConcurrency: 128,
  readConcurrencyLevels: [512, 1_024, 256], restartBetweenSeedAndRead: true, deadlineMs: 180_000, stateDirectory};
await writeFile(resolve(artifacts, "plan.json"), JSON.stringify(plan, null, 2) + "\n");

const digest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
const bundles = resolve(stateDirectory, "bundles");
await mkdir(bundles, {recursive: true});
const built = await build({absWorkingDir: packageDirectory, metafile: true,
  entryPoints: {service: "bench/local-point-bucket-service.ts", driver: "bench/local-point-bucket-large-operator.ts"},
  outdir: bundles, outExtension: {".js": ".mjs"}, bundle: true, format: "esm", platform: "browser",
  target: "es2024", external: ["cloudflare:*", "node:*"], conditions: ["workerd", "worker", "browser"]});
const serviceBundle = resolve(bundles, "service.mjs"), driverBundle = resolve(bundles, "driver.mjs");
const manifest = async (path: string) => ({mainModule: "index.mjs", modules: {"index.mjs": {
  type: "esm" as const, contents: await readFile(path, "utf8"),
}}});
const serviceManifest = await manifest(serviceBundle), driverManifest = await manifest(driverBundle);
const runtimeConfig = () => new Miniflare({host: "127.0.0.1", port: 0,
  resourcePersistencePath: resolve(stateDirectory, "state"), telemetry: {enabled: false}, log: new Log(LogLevel.WARN),
  workers: [
    {config: {name: "driver", manifest: driverManifest, compatibilityDate: "2026-10-13", compatibilityFlags: ["nodejs_compat"], env: {
      BUCKETS: {type: "durable-object", worker: "service", exportName: "LocalPointBucketDO"}, RUN_ID: {type: "json", value: runId},
    }}},
    {config: {name: "service", manifest: serviceManifest, compatibilityDate: "2026-10-13", compatibilityFlags: ["nodejs_compat"],
      exports: {LocalPointBucketDO: {type: "durable-object", storage: "sqlite"}}}},
  ]});
const invoke = async (runtime: Miniflare, path: "/seed" | "/read") => {
  const driver = await runtime.getWorker("driver");
  const response = await driver.fetch(`https://local.internal${path}`, {method: "POST"});
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(`Point bucket large ${path} returned HTTP ${response.status}`);
  return body;
};
const asRecord = (input: unknown): Record<string, unknown> | undefined =>
  typeof input === "object" && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
const phaseComplete = (input: unknown, name: "write" | "read", concurrency: number) => {
  const phase = asRecord(asRecord(input)?.[name]);
  return phase?.["issued"] === 16_384 && phase["completed"] === 16_384 && phase["failed"] === 0 &&
    phase["offeredConcurrency"] === concurrency && phase["observedMaxInFlight"] === concurrency;
};
const readsComplete = (input: unknown) => {
  const phases = asRecord(input)?.["phases"];
  const expected = [512, 1_024, 256];
  return Array.isArray(phases) && phases.length === expected.length && phases.every((phase, index) => {
    const record = asRecord(phase);
    return record?.["issued"] === 16_384 && record["completed"] === 16_384 && record["failed"] === 0 &&
      record["offeredConcurrency"] === expected[index] && record["observedMaxInFlight"] === expected[index];
  });
};

let complete = false, runtime: Miniflare | undefined;
try {
  runtime = runtimeConfig();
  await runtime.ready;
  const seed = await invoke(runtime, "/seed");
  await runtime.dispose();
  runtime = undefined;
  runtime = runtimeConfig();
  await runtime.ready;
  const reads = await invoke(runtime, "/read");
  const wroteAll = phaseComplete(seed, "write", 128), readAll = readsComplete(reads);
  const report = {plan, completed: wroteAll && readAll, source: {
      operatorSha256: await digest(resolve(packageDirectory, "bench/local-point-bucket-large-operator.ts")),
      bucketDoSha256: await digest(resolve(packageDirectory, "bench/local-point-bucket-do.ts")),
      serviceBundleSha256: await digest(serviceBundle), driverBundleSha256: await digest(driverBundle),
      inputPaths: Object.keys(built.metafile.inputs).sort(),
    }, seed, reads,
    scope: "Local Miniflare/SQLite 16,384-key, 32-bucket cold-restart profile at read concurrency 1,024/512/256. Exact values and revision checked; no retries; no Cloudflare deployment or resource mutation; no cross-bucket transactions or Datalog semantics."};
  await writeFile(resolve(artifacts, "report.json"), JSON.stringify(report, null, 2) + "\n");
  complete = wroteAll && readAll;
  console.log(JSON.stringify({runId, artifacts, completed: complete, seed, reads}));
} finally {
  await runtime?.dispose();
  if (complete) await rm(stateDirectory, {recursive: true, force: true});
  else console.error(JSON.stringify({event: "local-point-bucket-large-state-retained", runId, stateDirectory, artifacts}));
}
