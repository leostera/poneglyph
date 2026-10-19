import {createHash, randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {build} from "esbuild";
import {Log, LogLevel, Miniflare} from "miniflare";

const packageDirectory = resolve(import.meta.dirname, "..");
const runId = randomUUID();
const partitionCounts = [1, 2, 4, 8, 16, 32, 64, 128] as const;
const partitions = partitionCounts.map(count => ({count,
  graphIds: Array.from({length: count}, (_, index) => `control-partition-${count}-${index.toString().padStart(3, "0")}`)}));
const graphIds = partitions.flatMap(partition => partition.graphIds);
const stateDirectory = await mkdtemp(resolve(tmpdir(), "poneglyph-partition-counts-"));
const artifacts = resolve(packageDirectory, ".artifacts/local-partition-counts", runId);
await mkdir(artifacts, {recursive: true});
const plan = {runId, sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim(),
  localOnly: true, tenantCount: 128, partitionCounts: partitions.map(({count}) => count),
  queriesPerLayout: 128, offeredConcurrency: 128, deadlineMs: 20_000, stateDirectory};
await writeFile(resolve(artifacts, "plan.json"), JSON.stringify(plan, null, 2) + "\n");

const digest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
const bundles = resolve(stateDirectory, "bundles");
await mkdir(bundles, {recursive: true});
const built = await build({absWorkingDir: packageDirectory, metafile: true,
  entryPoints: {service: "test/cache-test-service.ts", driver: "bench/local-partition-counts-operator.ts"},
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
      PARTITIONS: {type: "json", value: partitions}, RUN_ID: {type: "json", value: runId},
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
    if (!response.ok) throw new Error(`Local partition count experiment returned HTTP ${response.status}`);
    return body;
  };
  const seed = await invoke("/seed");
  await writeFile(resolve(artifacts, "seed.json"), JSON.stringify(seed, null, 2) + "\n");
  const seedIsComplete = typeof seed === "object" && seed !== null && "partitionCounts" in seed &&
    Array.isArray(seed.partitionCounts) && seed.partitionCounts.length === partitions.length &&
    seed.partitionCounts.every((entry, index) => typeof entry === "object" && entry !== null &&
      "partitionCount" in entry && entry.partitionCount === partitions[index]!.count &&
      "acknowledged" in entry && entry.acknowledged === partitions[index]!.count &&
      "failedPartitions" in entry && Array.isArray(entry.failedPartitions) && entry.failedPartitions.length === 0);
  const reads = seedIsComplete ? await invoke("/read") : {skipped: "seed did not complete for every partition layout"};
  const phases = typeof reads === "object" && reads !== null && "phases" in reads && Array.isArray(reads.phases)
    ? reads.phases : [];
  const readsAreComplete = phases.length === partitions.length && phases.every((phase, index) => typeof phase === "object" &&
    phase !== null && "partitionCount" in phase && phase.partitionCount === partitions[index]!.count &&
    "offered" in phase && phase.offered === 128 && "completed" in phase && phase.completed === 128 &&
    "failed" in phase && phase.failed === 0 && "exactAnswers" in phase && phase.exactAnswers === 128 &&
    "observedMaxInFlight" in phase && phase.observedMaxInFlight === 128);
  const report = {plan, completed: seedIsComplete && readsAreComplete, source: {
      operatorSha256: await digest(resolve(packageDirectory, "bench/local-partition-counts-operator.ts")),
      harnessSha256: await digest(resolve(packageDirectory, "bench/local-partition-counts.ts")),
      serviceBundleSha256: await digest(serviceBundle), driverBundleSha256: await digest(driverBundle),
      inputPaths: Object.keys(built.metafile.inputs).sort(),
    }, seed, reads,
    scope: "Local Miniflare/SQLite comparison of graph-authority partition counts for aggregate independent point reads; closed-loop one-shot sample, not Cloudflare placement, SLA, or infinite-capacity evidence."};
  await writeFile(resolve(artifacts, "report.json"), JSON.stringify(report, null, 2) + "\n");
  complete = seedIsComplete && readsAreComplete;
  console.log(JSON.stringify({runId, artifacts, completed: complete, seed, reads}));
} finally {
  await runtime.dispose();
  if (complete) await rm(stateDirectory, {recursive: true, force: true});
  else console.error(JSON.stringify({event: "local-partition-counts-state-retained", runId, stateDirectory, artifacts}));
}
