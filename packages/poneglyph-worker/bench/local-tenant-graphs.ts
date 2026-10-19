import {createHash, randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {build} from "esbuild";
import {Log, LogLevel, Miniflare} from "miniflare";

const packageDirectory = resolve(import.meta.dirname, "..");
const runId = randomUUID();
const graphIds = Array.from({length: 128}, (_, index) => `control-tenant-${index.toString().padStart(3, "0")}`);
const sharedGraph = "control-plane-shared";
const stateDirectory = await mkdtemp(resolve(tmpdir(), "poneglyph-tenant-graphs-"));
const artifacts = resolve(packageDirectory, ".artifacts/local-tenant-graphs", runId);
await mkdir(artifacts, {recursive: true});
const plan = {runId, sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim(),
  localOnly: true, graphIds: graphIds.length, sharedGraph, uniqueColdPointQueriesPerTenant: 4,
  queryRounds: [0, 1, 2, 3], offeredConcurrencyLevels: [16, 32, 64, 128], deadlineMs: 20_000, stateDirectory};
await writeFile(resolve(artifacts, "plan.json"), JSON.stringify(plan, null, 2) + "\n");

const digest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
const bundles = resolve(stateDirectory, "bundles");
await mkdir(bundles, {recursive: true});
const built = await build({absWorkingDir: packageDirectory, metafile: true,
  entryPoints: {service: "test/cache-test-service.ts", driver: "bench/local-tenant-graphs-operator.ts"},
  outdir: bundles, outExtension: {".js": ".mjs"}, bundle: true, format: "esm", platform: "browser",
  target: "es2024", external: ["cloudflare:*", "node:*"], conditions: ["workerd", "worker", "browser"]});
const serviceBundle = resolve(bundles, "service.mjs"), driverBundle = resolve(bundles, "driver.mjs");
const manifest = async (path: string) => ({mainModule: "index.mjs", modules: {"index.mjs": {
  type: "esm" as const, contents: await readFile(path, "utf8"),
}}});
const serviceManifest = await manifest(serviceBundle), driverManifest = await manifest(driverBundle);
const durable = (exportName: string) => ({type: "durable-object" as const, worker: "service", exportName});
const grants = {"local-benchmark": Object.fromEntries([...graphIds, sharedGraph].map(graphId => [graphId, ["read", "write"]]))};
const compatibility = {compatibilityDate: "2026-10-13", compatibilityFlags: ["nodejs_compat"]};
const runtime = new Miniflare({host: "127.0.0.1", port: 0,
  resourcePersistencePath: resolve(stateDirectory, "state"), telemetry: {enabled: false}, log: new Log(LogLevel.WARN),
  workers: [
    {config: {name: "driver", manifest: driverManifest, ...compatibility, env: {
      PONEGLYPH: {type: "worker", worker: "service", props: {clientId: "local-benchmark"}},
      GRAPH_IDS: {type: "json", value: graphIds}, RUN_ID: {type: "json", value: runId},
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
    }}}
  ]});

let complete = false;
try {
  await runtime.ready;
  const driver = await runtime.getWorker("driver");
  const invoke = async (path: string) => {
    const response = await driver.fetch(`https://local.internal${path}`, {method: "POST"});
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(`Local tenant graph experiment returned HTTP ${response.status}`);
    return body;
  };
  const seed = await invoke("/seed");
  const seedPath = resolve(artifacts, "seed.json");
  await writeFile(seedPath, JSON.stringify(seed, null, 2) + "\n");
  const seedIsComplete = typeof seed === "object" && seed !== null &&
    (seed as Record<string, unknown>)["sharedWriteAcknowledged"] === true &&
    (seed as Record<string, unknown>)["completedIndependentWrites"] === graphIds.length;
  const reads = seedIsComplete ? await invoke("/read") : {skipped: "seed did not complete for all graph IDs"};
  const phases = typeof reads === "object" && reads !== null && "phases" in reads && Array.isArray(reads.phases)
    ? reads.phases : [];
  const readsAreComplete = phases.length === 8 && phases.every(phase => typeof phase === "object" && phase !== null &&
    "offered" in phase && phase.offered === graphIds.length && "completed" in phase && phase.completed === graphIds.length &&
    "failed" in phase && phase.failed === 0 && "exactAnswers" in phase && phase.exactAnswers === graphIds.length &&
    "observedMaxInFlight" in phase && "offeredConcurrency" in phase && phase.observedMaxInFlight === phase.offeredConcurrency);
  const report = {plan, completed: seedIsComplete && readsAreComplete, source: {
      operatorSha256: await digest(resolve(packageDirectory, "bench/local-tenant-graphs-operator.ts")),
      harnessSha256: await digest(resolve(packageDirectory, "bench/local-tenant-graphs.ts")),
      serviceBundleSha256: await digest(serviceBundle), driverBundleSha256: await digest(driverBundle),
      inputPaths: Object.keys(built.metafile.inputs).sort(),
    }, seed, reads,
    scope: "Local Miniflare/SQLite comparison of unique cold pointed reads on one graph versus one graph per tenant at offered concurrency 16/32/64/128; closed-loop one-shot sample, not Cloudflare placement, SLA, or infinite-capacity evidence."};
  await writeFile(resolve(artifacts, "report.json"), JSON.stringify(report, null, 2) + "\n");
  complete = seedIsComplete && readsAreComplete;
  console.log(JSON.stringify({runId, artifacts, completed: complete, seed, reads}));
} finally {
  await runtime.dispose();
  if (complete) await rm(stateDirectory, {recursive: true, force: true});
  else console.error(JSON.stringify({event: "local-tenant-graphs-state-retained", runId, stateDirectory, artifacts}));
}
