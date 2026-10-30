import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import {mkdir, mkdtemp, readFile, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";
import {Miniflare, Log, LogLevel} from "miniflare";
import {isRecord} from "../../poneglyph/src/domain/result.js";
import {coordinatorObjectName} from "../../poneglyph/src/storage/keys.js";
import {readHeadReplicaName} from "../../poneglyph/src/storage/read-head-placement.js";
import {parseGraphId} from "../../poneglyph/src/domain/graph-id.js";

// The last real source revision before canonical read-head publication/opt-in.
const legacy = "32232625b0a8cdaeda62240c967b2685c8d3f305";
const graphId = "local-read-head-rollback";
const query = 'test:flag("test:rollback", Value)';
const queryPath = `/v1/graphs/${graphId}/query`, writePath = `/v1/graphs/${graphId}/transactions`;
const fact = (value: boolean, retraction = false) => ({source: "agent:rollback-test", entity: "test:rollback", field: "test:flag", value: {type: "boolean", value}, retraction});

/** Suppress backend logs; retain only a recognized schema-fence signal. */
class FenceLog extends Log {
  rejectedMarker = 0;
  constructor() { super(LogLevel.VERBOSE); }
  observe(message: string): void {
    if (message.includes("unsupported g-facade Durable Object schema marker; refusing to reinterpret persisted data")) this.rejectedMarker++;
  }
  protected override log(message: string): void { this.observe(message); }
}

export async function checkReadHeadRollback(): Promise<string> {
  const graph = parseGraphId(graphId); assert.ok(graph.ok);
  const replicaName = readHeadReplicaName(graph.value, 1);
  const repo = resolve(import.meta.dirname, "../../..");
  const directory = await mkdtemp(resolve(tmpdir(), "poneglyph-head-rollback-"));
  const runId = randomUUID(), out = resolve(import.meta.dirname, "../.artifacts/read-head-rollback", runId);
  await mkdir(out, {recursive: true});
  const seed = {clientRequestToken: `rollback:${runId}:seed`, facts: [fact(false)]};
  const rejected = {clientRequestToken: `rollback:${runId}:legacy-rejected`, facts: [fact(true)]};
  const flip = {clientRequestToken: `rollback:${runId}:current-flip`, facts: [fact(false, true), fact(true)]};
  // Private immutable inputs survive any uncertain local write delivery.
  await writeFile(resolve(out, "private-write-plan.json"), JSON.stringify({graphId, seed, rejected, flip}, null, 2) + "\n", {flag: "wx"});
  await writeFile(resolve(out, "harness.ts"), await readFile(import.meta.filename), {flag: "wx"});
  let runtime: Miniflare | undefined, complete = false;
  const steps: object[] = [], log = new FenceLog();
  const checkpoint = async () => writeFile(resolve(out, "report.json"), JSON.stringify({runId, legacySourceCommit: legacy,
    complete, localOnly: true, stateDirectory: directory, schemaFenceSignals: log.rejectedMarker, steps}, null, 2) + "\n");
  try {
    const archive = execFileSync("git", ["archive", legacy, "packages/poneglyph/src"], {cwd: repo, maxBuffer: 32_000_000});
    const old = resolve(directory, "legacy"); await mkdir(old);
    execFileSync("tar", ["-xf", "-", "-C", old], {input: archive});
    // Both are complete, unmodified production storage Worker entrypoints.
    // No replacement initializer, fake version predicate or facade subclass.
    const built = await build({absWorkingDir: repo, entryPoints: {current: "packages/poneglyph/src/worker.ts",
      legacy: resolve(old, "packages/poneglyph/src/worker.ts")}, outdir: directory, outExtension: {".js": ".mjs"},
      bundle: true, metafile: true, format: "esm", platform: "browser", target: "es2024",
      external: ["cloudflare:*", "node:*"], conditions: ["workerd", "worker", "browser"], nodePaths: [resolve(repo, "node_modules")]});
    const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
    await writeFile(resolve(out, "source-inputs.json"), JSON.stringify({legacySourceCommit: legacy,
      currentSourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {cwd: repo, encoding: "utf8"}).trim(),
      legacyArchiveSha256: hash(archive), harnessSha256: hash(await readFile(import.meta.filename)),
      bundles: await Promise.all(["current", "legacy"].map(async name => ({name, sha256: hash(await readFile(resolve(directory, `${name}.mjs`)))}))),
      inputs: await Promise.all(Object.keys(built.metafile.inputs).map(async path => ({path, sha256: hash(await readFile(resolve(repo, path)))}))),
    }, null, 2) + "\n");
    const start = async (version: "current" | "legacy") => {
      const namespace = (exportName: string) => ({type: "durable-object" as const, worker: "storage", exportName});
      const next = new Miniflare({host: "127.0.0.1", port: 0, resourcePersistencePath: resolve(directory, "state"), telemetry: {enabled: false}, log,
        workers: [{config: {name: "storage", compatibilityDate: "2026-10-13", compatibilityFlags: ["nodejs_compat"],
          manifest: {mainModule: "index.mjs", modules: {"index.mjs": {type: "esm", contents: await readFile(resolve(directory, `${version}.mjs`), "utf8")}}},
          env: {GRAPH_FACADES: namespace("GraphCoordinatorDO"), GRAPH_LEDGERS: namespace("GraphLedgerDO"), GRAPH_TREES: namespace("GraphTreeDO"), GRAPH_SHARDS: namespace("GraphShardDO")},
          exports: {GraphCoordinatorDO: {type: "durable-object", storage: "sqlite"}, GraphLedgerDO: {type: "durable-object", storage: "sqlite"}, GraphTreeDO: {type: "durable-object", storage: "sqlite"}, GraphShardDO: {type: "durable-object", storage: "sqlite"}}}},
          {config: {name: "control", compatibilityDate: "2026-10-13", env: {FACADE: namespace("GraphCoordinatorDO")}, manifest: {mainModule: "index.mjs", modules: {"index.mjs": {type: "esm", contents: `
            export default {fetch(request, env) {
              const head = new URL(request.url).pathname === "/_replica-head-validate";
              const name = head ? ${JSON.stringify(replicaName)} : ${JSON.stringify(coordinatorObjectName(graphId))};
              return env.FACADE.getByName(name).fetch(head ? new Request("https://local.internal/_read-head-validate", request) : request);
            }};`}}}}}],
      });
      await next.ready; return next;
    };
    const restart = async (version: "current" | "legacy") => {
      await runtime?.dispose(); runtime = undefined;
      runtime = await start(version);
    };
    const call = async (path: string, body: unknown, control = false) => {
      assert.ok(runtime);
      const priorSignals = log.rejectedMarker;
      try {
        const worker = await runtime.getWorker(control ? "control" : "storage");
        const answer = await worker.fetch(`https://local.internal${path}`, {method: "POST", body: JSON.stringify(body)});
        if (answer.status !== 200) {
          // Inspect a bounded private error only for the fixed fence signal;
          // never retain or print the body, stack, request or arbitrary text.
          const reader = answer.body?.getReader(), decoder = new TextDecoder();
          let bytes = 0, carry = "";
          try {
            while (reader !== undefined && bytes < 16_384) {
              const chunk = await reader.read(); if (chunk.done) break;
              const remaining = 16_384 - bytes;
              bytes += chunk.value.byteLength;
              const text = carry + decoder.decode(chunk.value.subarray(0, remaining), {stream: true});
              log.observe(text); carry = text.slice(-128);
            }
          } finally { await reader?.cancel(); }
          return {status: answer.status, body: null, recognizedFence: log.rejectedMarker > priorSignals};
        }
        const decoded: unknown = await answer.json();
        assert.ok(isRecord(decoded));
        return {status: answer.status, body: decoded, recognizedFence: log.rejectedMarker > priorSignals};
      } catch (error) {
        if (error instanceof Error) log.observe(error.message);
        return {status: null, body: null, recognizedFence: log.rejectedMarker > priorSignals};
      }
    };
    const expectQuery = async (value: boolean, snapshotSeq: number) => {
      const answer = await call(queryPath, {query});
      assert.equal(answer.status, 200); assert.ok(answer.body);
      const rows = answer.body["rows"];
      assert.ok(Array.isArray(rows) && rows.length === 1 && isRecord(rows[0]) && Object.keys(rows[0]).length === 1 &&
        isRecord(rows[0]["Value"]) && Object.keys(rows[0]["Value"]).length === 2 && rows[0]["Value"]["type"] === "string" &&
        rows[0]["Value"]["value"] === String(value), "Expected the exact typed rollback-fixture row bag");
      assert.equal(answer.body["snapshotSeq"], snapshotSeq);
      return answer.body;
    };
    await restart("current");
    const seeded = await call(writePath, seed);
    assert.equal(seeded.status, 200); assert.ok(seeded.body && typeof seeded.body["txId"] === "string");
    await expectQuery(false, 1);
    steps.push({stage: "current-disabled-seed", confirmed: true}); await checkpoint();
    await restart("legacy"); await expectQuery(false, 1);
    assert.equal(log.rejectedMarker, 0);
    steps.push({stage: "actual-legacy-schema-2-positive-control", completeExactAnswer: true}); await checkpoint();
    await restart("current");
    const joined = await call("/_read-head-join", {graphId, expectedGeneration: 0}, true);
    assert.equal(joined.status, 200); assert.ok(joined.body && joined.body["member"] === 1 && joined.body["pending"] === false);
    const status = await call("/_read-head-status", {graphId}, true);
    assert.ok(status.body && status.body["enabled"] === true);
    assert.deepEqual(status.body["members"], [1]);
    await expectQuery(false, 1);
    steps.push({stage: "current-explicit-opt-in-preserves-data", activeMembers: 1}); await checkpoint();
    await restart("legacy");
    const rejectedRead = await call(queryPath, {query});
    assert.notEqual(rejectedRead.status, 200);
    const rejectedWrite = await call(writePath, rejected);
    assert.notEqual(rejectedWrite.status, 200);
    assert.ok(log.rejectedMarker > 0, "Expected actual legacy startup marker rejection, not an unrelated failed request");
    assert.equal(rejectedRead.recognizedFence, true); assert.equal(rejectedWrite.recognizedFence, true);
    steps.push({stage: "actual-legacy-schema-3-exclusion", readStatus: rejectedRead.status, writeStatus: rejectedWrite.status,
      recognizedReadMarkerRejection: true, recognizedWriteMarkerRejection: true}); await checkpoint();
    await restart("current");
    const beforeFlip = await expectQuery(false, 1);
    const flipped = await call(writePath, flip);
    assert.equal(flipped.status, 200); assert.ok(flipped.body && typeof flipped.body["txId"] === "string");
    const afterFlip = await expectQuery(true, 2);
    const validate = async (result: Record<string, unknown>) => {
      const vector = result["snapshotVector"]; assert.ok(Array.isArray(vector) && vector.length === 1);
      const knownSnapshot = vector.map((owner: unknown) => {
        assert.ok(isRecord(owner));
        return {prefix: owner["prefix"], snapshotSeq: owner["sequence"], directoryEpoch: owner["epoch"]};
      });
      return call("/_replica-head-validate", {graphId, member: 1, query, knownSnapshot}, true);
    };
    const stale = await validate(beforeFlip), fresh = await validate(afterFlip);
    assert.equal(stale.status, 200); assert.deepEqual(stale.body, {canonical: true});
    assert.equal(fresh.status, 200); assert.deepEqual(fresh.body, {unchanged: true, snapshotSeq: 2});
    const recoveredStatus = await call("/_read-head-status", {graphId}, true);
    assert.ok(recoveredStatus.body && recoveredStatus.body["enabled"] === true);
    assert.deepEqual(recoveredStatus.body["members"], [1]);
    steps.push({stage: "current-reopen-and-publish-after-rejection", unchangedBeforeNewWrite: true, completeExactSnapshotAfterWrite: 2, activeMembers: 1, headRejectsOldIdentity: true, headAcceptsNewIdentity: true});
    complete = true; await checkpoint();
    return out;
  } finally {
    await runtime?.dispose(); await checkpoint();
    if (complete) await rm(directory, {recursive: true, force: true});
    console.log(JSON.stringify({runId, complete, artifacts: out, localStateRetained: !complete}));
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error("Usage: read-head-rollback.ts");
  await checkReadHeadRollback();
}
