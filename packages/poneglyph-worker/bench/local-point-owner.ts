import {createHash, randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {build} from "esbuild";
import {Log, LogLevel, Miniflare} from "miniflare";

const packageDirectory = resolve(import.meta.dirname, "..");
const runId = randomUUID();
const graphIds = Array.from({length: 128}, (_, index) => `control-key-graph-${index.toString().padStart(3, "0")}`);
const lookupKeys = Array.from({length: 128}, (_, index) => `control:tenant:${index.toString().padStart(3, "0")}:feature-settings`);
const stateDirectory = await mkdtemp(resolve(tmpdir(), "poneglyph-point-owner-"));
const artifacts = resolve(packageDirectory, ".artifacts/local-point-owner", runId);
await mkdir(artifacts, {recursive: true});
const plan = {runId, sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim(),
  localOnly: true, keyCount: graphIds.length, offeredConcurrency: graphIds.length,
  architectures: ["Poneglyph graph per key", "append-only point-owner DO per key"],
  routingModes: ["unique-keys", "single-hot-key"], deadlineMs: 20_000, stateDirectory};
await writeFile(resolve(artifacts, "plan.json"), JSON.stringify(plan, null, 2) + "\n");

const digest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
const bundles = resolve(stateDirectory, "bundles");
await mkdir(bundles, {recursive: true});
const built = await build({absWorkingDir: packageDirectory, metafile: true,
  entryPoints: {service: "bench/local-point-owner-service.ts", driver: "bench/local-point-owner-operator.ts"},
  outdir: bundles, outExtension: {".js": ".mjs"}, bundle: true, format: "esm", platform: "browser",
  target: "es2024", external: ["cloudflare:*", "node:*"], conditions: ["workerd", "worker", "browser"]});
const serviceBundle = resolve(bundles, "service.mjs"), driverBundle = resolve(bundles, "driver.mjs");
const manifest = async (path: string) => ({mainModule: "index.mjs", modules: {"index.mjs": {
  type: "esm" as const, contents: await readFile(path, "utf8"),
}}});
const serviceManifest = await manifest(serviceBundle), driverManifest = await manifest(driverBundle);
const durable = (exportName: string) => ({type: "durable-object" as const, worker: "service", exportName});
const grants = {"local-benchmark": Object.fromEntries(graphIds.map(graphId => [graphId, ["read", "write"]]))};
const compatibility = {compatibilityDate: "2026-10-13", compatibilityFlags: ["nodejs_compat"]};
const runtime = new Miniflare({host: "127.0.0.1", port: 0,
  resourcePersistencePath: resolve(stateDirectory, "state"), telemetry: {enabled: false}, log: new Log(LogLevel.WARN),
  workers: [
    {config: {name: "driver", manifest: driverManifest, ...compatibility, env: {
      PONEGLYPH: {type: "worker", worker: "service", props: {clientId: "local-benchmark"}},
      POINT_OWNERS: durable("LocalPointOwnerDO"),
      GRAPH_IDS: {type: "json", value: graphIds}, LOOKUP_KEYS: {type: "json", value: lookupKeys},
      RUN_ID: {type: "json", value: runId},
    }}},
    {config: {name: "service", manifest: serviceManifest, ...compatibility, env: {
      GRAPH_FACADES: durable("GraphCoordinatorDO"), GRAPH_LEDGERS: durable("GraphLedgerDO"),
      GRAPH_TREES: durable("GraphTreeDO"), GRAPH_SHARDS: durable("GraphShardDO"),
      GRAPH_GRANTS: {type: "json", value: grants},
    }, exports: {
      GraphCoordinatorDO: {type: "durable-object", storage: "sqlite"},
      GraphLedgerDO: {type: "durable-object", storage: "sqlite"},
      GraphTreeDO: {type: "durable-object", storage: "sqlite"},
      GraphShardDO: {type: "durable-object", storage: "sqlite"},
      LocalPointOwnerDO: {type: "durable-object", storage: "sqlite"},
    }}}
  ]});

let complete = false;
try {
  await runtime.ready;
  const driver = await runtime.getWorker("driver");
  const response = await driver.fetch("https://local.internal/seed", {method: "POST"});
  const seed: unknown = await response.json();
  if (!response.ok) throw new Error(`Point-owner seed returned HTTP ${response.status}`);
  await writeFile(resolve(artifacts, "seed.json"), JSON.stringify(seed, null, 2) + "\n");
  const readsResponse = await driver.fetch("https://local.internal/read", {method: "POST"});
  const reads: unknown = await readsResponse.json();
  if (!readsResponse.ok) throw new Error(`Point-owner read returned HTTP ${readsResponse.status}`);
  const phases = typeof reads === "object" && reads !== null && "phases" in reads && Array.isArray(reads.phases)
    ? reads.phases : [];
  const seedComplete = typeof seed === "object" && seed !== null && "graphWrites" in seed && "pointOwnerWrites" in seed &&
    [seed.graphWrites, seed.pointOwnerWrites].every(value => typeof value === "object" && value !== null &&
      "issued" in value && value.issued === 128 && "acknowledged" in value && value.acknowledged === 128 &&
      "failed" in value && value.failed === 0);
  const readsComplete = phases.length === 4 && phases.every(phase => typeof phase === "object" && phase !== null &&
    "issued" in phase && phase.issued === 128 && "completed" in phase && phase.completed === 128 &&
    "failed" in phase && phase.failed === 0 && "exactAnswers" in phase && phase.exactAnswers === 128 &&
    "observedMaxInFlight" in phase && phase.observedMaxInFlight === 128);
  const report = {plan, completed: seedComplete && readsComplete, source: {
      operatorSha256: await digest(resolve(packageDirectory, "bench/local-point-owner-operator.ts")),
      pointOwnerDoSha256: await digest(resolve(packageDirectory, "bench/local-point-owner-do.ts")),
      serviceBundleSha256: await digest(serviceBundle), driverBundleSha256: await digest(driverBundle),
      inputPaths: Object.keys(built.metafile.inputs).sort(),
    }, seed, reads,
    scope: "Local comparison of full Poneglyph per-key graphs against a benchmark-only append-only single-key Durable Object. The key-owner design explicitly excludes graph-wide transaction atomicity, Datalog joins and cross-key snapshots; no Cloudflare deployment or resource mutation."};
  await writeFile(resolve(artifacts, "report.json"), JSON.stringify(report, null, 2) + "\n");
  complete = seedComplete && readsComplete;
  console.log(JSON.stringify({runId, artifacts, completed: complete, seed, reads}));
} finally {
  await runtime.dispose();
  if (complete) await rm(stateDirectory, {recursive: true, force: true});
  else console.error(JSON.stringify({event: "local-point-owner-state-retained", runId, stateDirectory, artifacts}));
}
