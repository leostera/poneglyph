import {mkdtemp, mkdir, readFile, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {createHash, randomUUID} from "node:crypto";
import {gzipSync} from "node:zlib";
import {build} from "esbuild";
import {Miniflare, Log, LogLevel} from "miniflare";
import {isRecord} from "../../poneglyph/src/domain/result.js";
import {latencyStats, parseProbeResult, successful, transportFailure, type Sample, type ReadPhase} from "./plan.js";
import {settledWaves} from "./waves.js";

type Counters = Readonly<{readCutCalls: number; discoveryCalls: number; heads: readonly Readonly<{member: number; validations: number}>[]}>;
function counters(input: unknown): Counters {
  const counter = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (!isRecord(input) || Object.keys(input).length !== 3 || !counter(input["readCutCalls"]) || !counter(input["discoveryCalls"]) || !Array.isArray(input["heads"])) throw new Error("Invalid local counters");
  const seen = new Set<number>();
  const heads = input["heads"].map((head: unknown) => {
    if (!isRecord(head) || Object.keys(head).length !== 2 || !counter(head["member"]) || head["member"] < 1 || seen.has(head["member"]) || !counter(head["validations"])) throw new Error("Invalid local head counter");
    seen.add(head["member"]);
    return {member: head["member"], validations: head["validations"]};
  });
  return {readCutCalls: input["readCutCalls"], discoveryCalls: input["discoveryCalls"], heads};
}

/** Explicit experiment: fresh LOCAL SQLite only, never Cloudflare credentials. */
export async function runLocalReadHeads(count: number): Promise<string> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1_250) throw new Error("Expected 1–1250 calls per round (at most 10000 measured reads)");
  const runId = randomUUID();
  const directory = await mkdtemp(resolve(tmpdir(), "poneglyph-local-read-heads-"));
  const out = resolve(import.meta.dirname, "../.artifacts/read-head-local", runId);
  await mkdir(out, {recursive: true});
  const roundsPerPlacement: readonly ReadPhase[] = [{kind: "point", concurrency: 16, count}, {kind: "combined", concurrency: 128, count}];
  const plan = {runId, localOnly: true, graphId: "control-plane-validation", seedToken: `local-heads:${runId}:seed`,
    heads: [0, 1, 4, 8], roundsPerPlacement,
    warmupPerQuery: 64, deadlineMs: 10_000, stateDirectory: directory};
  await writeFile(resolve(out, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
  let runtime: Miniflare | undefined, succeeded = false;
  const rounds: object[] = [], warmups: object[] = [];
  let stopReason = "setup-error";
  const checkpoint = async () => {
    const report = {plan, stopReason, completed: succeeded, warmups, rounds, scope: "One local machine, real native RPC/SQLite, warm closed-loop waves, no geographic or hosted capacity certification. Placement/load rounds of ONE architecture, not distinct architectures."};
    const bytes = gzipSync(JSON.stringify(report));
    await writeFile(resolve(out, "report.json.gz"), bytes);
    await writeFile(resolve(out, "report.sha256"), createHash("sha256").update(bytes).digest("hex") + "\n");
  };
  try {
    await build({absWorkingDir: resolve(import.meta.dirname, ".."), entryPoints: {
      service: "test/cache-test-service.ts", probe: "bench/operator.ts", admin: "bench/local-head-admin.ts",
    }, outdir: directory, outExtension: {".js": ".mjs"}, bundle: true, format: "esm", platform: "browser", target: "es2024", external: ["cloudflare:*", "node:*"], conditions: ["workerd", "worker", "browser"]});
    const manifest = async (name: string) => ({mainModule: "index.mjs", modules: {"index.mjs": {type: "esm" as const, contents: await readFile(resolve(directory, `${name}.mjs`), "utf8")}}});
    const probe = await manifest("probe"), service = await manifest("service"), admin = await manifest("admin");
    const binding = {type: "worker" as const, worker: "service", props: {clientId: "local-benchmark"}};
    const facade = {type: "durable-object" as const, worker: "service", exportName: "GraphCoordinatorDO"};
    const start = async () => {
      const next = new Miniflare({host: "127.0.0.1", port: 0, resourcePersistencePath: resolve(directory, "state"), telemetry: {enabled: false}, log: new Log(LogLevel.WARN), workers: [
        {config: {name: "probe", manifest: probe, compatibilityDate: "2026-10-13", compatibilityFlags: ["nodejs_compat"], env: {PONEGLYPH: binding, RUN_ID: {type: "json", value: runId}}}},
        {config: {name: "admin", manifest: admin, compatibilityDate: "2026-10-13", compatibilityFlags: ["nodejs_compat"], env: {PONEGLYPH: binding, FACADE: facade, RUN_ID: {type: "json", value: runId}}}},
        {config: {name: "service", manifest: service, compatibilityDate: "2026-10-13", compatibilityFlags: ["nodejs_compat"], env: {
          GRAPH_FACADES: facade,
          GRAPH_LEDGERS: {type: "durable-object", worker: "service", exportName: "GraphLedgerDO"},
          GRAPH_TREES: {type: "durable-object", worker: "service", exportName: "GraphTreeDO"},
          GRAPH_SHARDS: {type: "durable-object", worker: "service", exportName: "GraphShardDO"},
          GRAPH_GRANTS: {type: "json", value: {"local-benchmark": {"control-plane-validation": ["read", "write"]}}},
        }, exports: {GraphCoordinatorDO: {type: "durable-object", storage: "sqlite"}, GraphLedgerDO: {type: "durable-object", storage: "sqlite"}, GraphTreeDO: {type: "durable-object", storage: "sqlite"}, GraphShardDO: {type: "durable-object", storage: "sqlite"}}}},
      ]});
      await next.ready;
      return next;
    };
    runtime = await start();
    const control = async (path: string) => {
      if (runtime === undefined) throw new Error("Local runtime unavailable");
      const worker = await runtime.getWorker("admin");
      const response = await worker.fetch(`https://local.internal${path}`, {method: "POST"});
      const body: unknown = await response.json();
      if (response.status !== 200) throw new Error("Local control was not confirmed; do not replay seed");
      return body;
    };
    const receipt = await control("/seed");
    if (!isRecord(receipt) || typeof receipt["txId"] !== "string") throw new Error("Uncertain local seed; do not replay");
    await writeFile(resolve(out, "seed-receipt.json"), JSON.stringify(receipt) + "\n");
    let installed = 0;
    for (const heads of plan.heads) {
      while (installed < heads) {
        const joined = await control("/join");
        if (!isRecord(joined) || joined["pending"] !== false || typeof joined["member"] !== "number") throw new Error("Local join not confirmed");
        installed++;
      }
      // Same durable data/namespaces, fresh Worker isolates/hints per placement.
      // No 30-second hint wait or reuse of another invocation's I/O.
      await runtime.dispose(); runtime = undefined;
      runtime = await start();
      const active = runtime;
      const probeCall = async (kind: "point" | "combined") => {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), plan.deadlineMs);
        const started = performance.now();
        try {
          const response = await active.dispatchFetch(`https://local.test/${kind}`, {method: "POST", signal: controller.signal});
          const result = parseProbeResult(await response.json(), runId);
          if (response.status !== (result.kind === "complete" ? 200 : 502)) throw new SyntaxError("Invalid local probe status");
          return {callerMs: performance.now() - started, result} satisfies Sample;
        } catch (error) { return {callerMs: performance.now() - started, failure: transportFailure(error)} satisfies Sample; }
        finally { clearTimeout(timer); }
      };
      for (const kind of ["point", "combined"] as const) {
        const warm = await settledWaves({kind, count: plan.warmupPerQuery, concurrency: 8}, () => probeCall(kind), wave => wave.every(outcome => outcome.status === "fulfilled" && successful(outcome.value)));
        warmups.push({heads, kind, observedMaxInFlight: warm.observedMaxInFlight, outcomes: warm.outcomes});
        await checkpoint();
        if (warm.outcomes.length !== plan.warmupPerQuery || warm.outcomes.some(outcome => outcome.status !== "fulfilled" || !successful(outcome.value))) throw new Error("Local warmup failed");
      }
      for (const phase of plan.roundsPerPlacement) {
        const before = counters(await control("/counts"));
        const started = performance.now(), launches: number[] = [];
        const settled = await settledWaves(phase, () => {
          launches.push(performance.now());
          return probeCall(phase.kind);
        }, wave => wave.every(outcome => outcome.status === "fulfilled" && successful(outcome.value)));
        const elapsedMs = performance.now() - started;
        const samples: Sample[] = settled.outcomes.map(outcome => outcome.status === "fulfilled" ? outcome.value : {callerMs: outcome.elapsedMs, failure: "protocol"});
        const launchSpanMs = launches.length < 2 ? 0 : launches.at(-1)! - launches[0]!;
        // Retain ALL settled measurements before a follow-up diagnostic can fail.
        await writeFile(resolve(out, `round-${rounds.length + 1}-settled.json.gz`), gzipSync(JSON.stringify({
          runId, heads, phase, elapsedMs, launchSpanMs, observedMaxInFlight: settled.observedMaxInFlight, samples,
        })), {flag: "wx"});
        const after = counters(await control("/counts"));
        const good = samples.filter(successful);
        const allLatency = latencyStats(samples.map(sample => sample.callerMs));
        const headValidations = after.heads.map(head => ({member: head.member,
          calls: head.validations - (before.heads.find(previous => previous.member === head.member)?.validations ?? 0)}));
        const rootReadCutCalls = after.readCutCalls - before.readCutCalls;
        const discoveryCalls = after.discoveryCalls - before.discoveryCalls;
        const routingAccountingValid = after.heads.length === heads && rootReadCutCalls >= 0 && discoveryCalls >= 0 &&
          headValidations.every(head => head.calls >= 0) && (heads === 0 ? rootReadCutCalls === samples.length :
            headValidations.reduce((total, head) => total + head.calls, 0) === samples.length);
        const round = {heads, phase, issued: samples.length, completed: good.length, failed: samples.length - good.length,
          observedMaxInFlight: settled.observedMaxInFlight, elapsedMs, launchSpanMs, callerAllOutcomes: allLatency,
          nativeSuccessOnly: latencyStats(good.map(sample => sample.result.metrics.hostedMs)),
          serviceSuccessOnly: latencyStats(good.map(sample => sample.result.metrics.serviceMs)),
          cacheHits: good.reduce((total, sample) => total + sample.result.metrics.cacheHits, 0),
          rootReadCutCalls, discoveryCalls, headValidations, routingAccountingValid,
          meetsLocalSampleTarget: samples.length === phase.count && good.length === phase.count && allLatency.p99 !== null && allLatency.p99 < 100,
          samples};
        rounds.push(round); stopReason = round.failed === 0 && round.issued === phase.count && routingAccountingValid ? "running" : "failed-round";
        await checkpoint();
        console.log(JSON.stringify({runId, heads, kind: phase.kind, concurrency: phase.concurrency, observedMaxInFlight: settled.observedMaxInFlight, issued: round.issued, completed: round.completed, callerP99: allLatency.p99, rootReadCutCalls: round.rootReadCutCalls, headValidations: round.headValidations}));
        if (stopReason === "failed-round") throw new Error("Local read round failed; no subsequent rounds issued");
      }
    }
    succeeded = true; stopReason = "all-local-rounds-completed";
    return out;
  } catch {
    if (stopReason !== "failed-round") stopReason = "unconfirmed-local-operation";
    throw new Error("Local read experiment stopped; inspect retained artifacts/state, never automatically replay its seed");
  } finally {
    await runtime?.dispose();
    await checkpoint();
    if (succeeded) await rm(directory, {recursive: true, force: true});
    console.log(JSON.stringify({runId, stopReason, artifacts: out, localStateRetained: !succeeded}));
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--count" || !/^[0-9]+$/.test(args[1]!))) throw new Error("Usage: local-heads.ts [--count 1..1250]");
  await runLocalReadHeads(args.length === 0 ? 1_000 : Number(args[1]));
}
