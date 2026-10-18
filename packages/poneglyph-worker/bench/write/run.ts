import {spawn, execFile} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import {mkdir, open, writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {createServer} from "node:net";
import {dirname, resolve} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {gzipSync} from "node:zlib";
import {isRecord} from "@leostera/poneglyph/storage-protocol";
import {latencyStats} from "../plan.js";
import {payload, settings} from "./model.js";
import {corpusSha256, pageSubsets} from "./corpus.js";
import {settledBurst} from "./burst.js";

const execute = promisify(execFile), here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, "../..");
const target = "poneglyph-mavplus-validation-worker", account = "0f436d2aabf1f872be90b8dd9d5715e6";
const port = 8877, base = `http://127.0.0.1:${port}`, environment = {...process.env, CLOUDFLARE_ACCOUNT_ID: account};
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
async function deployment() {
  const {stdout} = await execute("cf", ["workers", "deployments", "list", "--worker", target, "--per-page", "1"], {env: environment});
  const data: unknown = JSON.parse(stdout);
  if (!isRecord(data) || !Array.isArray(data["deployments"])) throw new Error("Invalid deployment");
  const first = data["deployments"][0];
  if (!isRecord(first) || !Array.isArray(first["versions"]) || first["versions"].length !== 1) throw new Error("Unstable deployment");
  const version = first["versions"][0];
  if (!isRecord(version) || version["percentage"] !== 100 || typeof version["version_id"] !== "string" || !/^[0-9a-f-]{36}$/.test(version["version_id"])) throw new Error("Unstable deployment version");
  return version["version_id"];
}
async function portFree() {
  const server = createServer();
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => server.close(error => error ? reject(error) : accept())); });
}
async function probe(scope: ReturnType<typeof settings>, path: string) {
  const response = await fetch(`${base}/${path}`, {method: path === "health" ? "GET" : "POST", signal: AbortSignal.timeout(60_000)});
  const body: unknown = await response.json();
  if (response.status !== 200 || !isRecord(body) || body["runId"] !== scope.runId || body["case"] !== scope.kind) throw new Error("Invalid operator probe");
  return body;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--case" || args[2] !== "--count") throw new Error("Usage: bench:write --case hot|graph --count 1..10000");
  const scope = settings(randomUUID(), args[1], Number(args[3]));
  await portFree();
  const versionBefore = await deployment();
  // The dataset and target are pinned; no repair or write to the existing corpus.
  const pages = scope.kind === "graph" ? await pageSubsets(resolve(root, "../write-path-bench/.data/facts.ndjson"), scope.count) : undefined;
  const inputs = Array.from({length: scope.count}, (_, index) => payload(scope, {index, ...(pages === undefined ? {} : {facts: pages[index]})}));
  const payloadHashes = inputs.map(input => hash(JSON.stringify(input.facts)));
  const datasetSha256 = hash(JSON.stringify(inputs.map(input => input.facts)));
  const {stdout: revision} = await execute("git", ["rev-parse", "HEAD"], {cwd: root});
  const {stdout: changes} = await execute("git", ["status", "--porcelain"], {cwd: root});
  const manifest = {...scope, target, account, versionBefore, sourceRevision: revision.trim(), dirty: changes.trim() !== "",
    startedAt: new Date().toISOString(), corpusSha256: pages === undefined ? null : corpusSha256, datasetSha256,
    factEvents: inputs.reduce((sum, input) => sum + input.facts.length, 0), retries: 0, caller: "private-preview-native-do-fetch-public-transaction-route",
    concurrency: scope.count, deadlineMs: 120_000, graphIsolation: "fresh-graph-existing-isolated-namespaces", replicaHeads: "not-enabled",
    transport: "local-http-proxy-to-authenticated-remote-preview", concurrencyBoundary: "offered-caller-not-simultaneous-backend-execution"};
  const artifact = resolve(root, ".artifacts/write-bench", scope.runId); await mkdir(artifact, {recursive: true});
  await writeFile(resolve(artifact, "plan.json"), JSON.stringify({manifest, payloadHashes}, null, 2) + "\n");
  const require = createRequire(import.meta.url), cfRequire = createRequire(require.resolve("cf/package.json"));
  const wrangler = resolve(dirname(cfRequire.resolve("wrangler/package.json")), "bin/wrangler.js");
  const log = await open(resolve(artifact, "dev.log"), "w");
  const child = spawn(process.execPath, [wrangler, "dev", "--remote", "--experimental-new-config", "--port", String(port), "--ip", "127.0.0.1"], {
    cwd: here, detached: true, stdio: ["ignore", log.fd, log.fd], env: {...environment,
      PONEGLYPH_WRITE_BENCH_RUN_ID: scope.runId, PONEGLYPH_WRITE_BENCH_CASE: scope.kind, PONEGLYPH_WRITE_BENCH_COUNT: String(scope.count)},
  });
  const exited = new Promise<void>(accept => { child.once("exit", () => accept()); child.once("error", () => accept()); });
  type Sample = {index: number; callerMs: number; kind: string; hostedMs?: number; backendStatus?: number; txId?: string};
  const samples: Sample[] = [], audits: Record<string, unknown>[] = [], verifications: {index: number; passed: boolean}[] = [];
  let stopped: string | null = "startup", versionAfter: string | null = null, elapsedMs = 0, launchSpanMs = 0, maxInFlight = 0;
  try {
    for (let attempt = 0; ; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null || attempt >= 100) throw new Error("Operator not ready");
      try { await probe(scope, "health"); break; } catch { await sleep(500); }
    }
    const baseline = await probe(scope, "preflight"); audits.push(baseline);
    if (baseline["kind"] !== "audit" || baseline["tokens"] !== 0) throw new Error("Graph is not initially empty");
    stopped = "execution";
    // Exactly one burst; no follow-on write waves after any failure.
    const burst = await settledBurst(inputs, async (input): Promise<Sample> => {
      const start = performance.now();
      try {
        const response = await fetch(`${base}/write`, {method: "POST", signal: AbortSignal.timeout(manifest.deadlineMs),
          body: JSON.stringify({index: input.index, ...(scope.kind === "graph" ? {facts: input.facts} : {})})});
        const body: unknown = await response.json();
        if (!isRecord(body) || body["runId"] !== scope.runId || body["case"] !== scope.kind || body["index"] !== input.index ||
            body["payloadSha256"] !== payloadHashes[input.index] || typeof body["kind"] !== "string" ||
            !["acknowledged", "contention", "overloaded", "capacity", "aborted", "unavailable", "rejected", "protocol", "disconnected", "timeout", "request-limit", "unknown"].includes(body["kind"]) ||
            typeof body["hostedMs"] !== "number" || !Number.isFinite(body["hostedMs"]) || body["hostedMs"] < 0 ||
            response.status !== (body["kind"] === "acknowledged" ? 200 : 502)) throw new Error("Invalid write witness");
        const txId = body["txId"], backendStatus = body["backendStatus"];
        if (body["kind"] === "acknowledged" && (typeof txId !== "string" || !/^poneglyph:tx:token:[0-9a-f]:[0-9a-f-]{36}$/.test(txId))) throw new Error("Invalid transaction identity");
        return {index: input.index, callerMs: performance.now() - start, kind: body["kind"], hostedMs: body["hostedMs"],
          ...(typeof backendStatus === "number" ? {backendStatus} : {}), ...(typeof txId === "string" ? {txId} : {})};
      } catch (error) {
        return {index: input.index, callerMs: performance.now() - start, kind: error instanceof Error && error.name === "TimeoutError" ? "caller-timeout" : "caller-transport-or-protocol"};
      }
    });
    launchSpanMs = burst.launchSpanMs; elapsedMs = burst.elapsedMs; maxInFlight = burst.observedMaximumCallerInFlight;
    for (const [index, result] of burst.outcomes.entries()) samples.push(result.status === "fulfilled" ? result.value : {index, callerMs: elapsedMs, kind: "harness-failure"});
    stopped = samples.every(sample => sample.kind === "acknowledged") ? null : "failed-burst-no-more-writes";
    console.log(JSON.stringify({runId: scope.runId, case: scope.kind, issued: samples.length, maxInFlight, launchSpanMs,
      elapsedMs, outcomes: samples.reduce<Record<string, number>>((counts, sample) => { counts[sample.kind] = (counts[sample.kind] ?? 0) + 1; return counts; }, {})}));
    // Observations only, not replays. SQL counts are per-bucket observations,
    // not one atomic graph-wide snapshot or proof about unobserved requests.
    for (const waitMs of [0, 30_000, 90_000]) {
      await sleep(waitMs);
      try {
        const audit = await probe(scope, "audit"); audits.push(audit);
        const counts = audit["phases"];
        if (samples.every(sample => sample.kind === "acknowledged") && isRecord(counts) && counts["complete"] === scope.count) break;
      } catch { audits.push({kind: "audit-unavailable", at: new Date().toISOString()}); }
    }
    const acknowledged = samples.filter(sample => sample.kind === "acknowledged");
    if (new Set(acknowledged.map(sample => sample.txId)).size !== acknowledged.length) stopped = "duplicate-acknowledgement-identity";
    const selected = acknowledged.filter((_sample, i) => i % Math.max(1, Math.floor(acknowledged.length / 16)) === 0).slice(0, 16).map(sample => sample.index);
    for (const index of selected) {
      let passed = false;
      try {
        const response = await fetch(`${base}/verify`, {method: "POST", signal: AbortSignal.timeout(60_000),
          body: JSON.stringify({index, ...(scope.kind === "graph" ? {facts: inputs[index]!.facts} : {})})});
        const body: unknown = await response.json();
        if (response.status !== 200 || !isRecord(body) || body["runId"] !== scope.runId || body["case"] !== scope.kind ||
            body["kind"] !== "verification" || body["index"] !== index || !Array.isArray(body["rows"])) throw new Error("Invalid verification response");
        const rows = body["rows"];
        if (scope.kind === "hot") passed = JSON.stringify(rows) === "[{}]";
        else {
          const title = inputs[index]!.facts.find(fact => isRecord(fact) && fact["field"] === "wiki:page:title");
          if (title === undefined || title.value.type !== "text") throw new Error("Invalid expected title");
          passed = JSON.stringify(rows) === JSON.stringify([{Title: {type: "string", value: title.value.value}}]);
        }
      } catch { /* Failed verification is retained, not retried or hidden. */ }
      verifications.push({index, passed});
    }
    if (verifications.some(result => !result.passed)) stopped = "verification-failed";
    versionAfter = await deployment(); if (versionAfter !== versionBefore) stopped = "deployment-drift";
  } finally {
    if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
    await Promise.race([exited, sleep(2_000)]);
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    await log.close();
    const acknowledged = samples.filter(sample => sample.kind === "acknowledged");
    const summary = {manifest, versionAfter, stopped, completedAt: new Date().toISOString(), issued: samples.length,
      acknowledged: acknowledged.length, failedAcknowledgements: samples.length - acknowledged.length, maxInFlight, launchSpanMs, elapsedMs,
      acknowledgedCallsPerSecond: elapsedMs === 0 ? 0 : acknowledged.length / (elapsedMs / 1000),
      allOutcomeCallerMs: latencyStats(samples.map(sample => sample.callerMs)),
      allReturnedHostedMs: latencyStats(samples.flatMap(sample => sample.hostedMs === undefined ? [] : [sample.hostedMs])),
      acknowledgedHostedMs: latencyStats(acknowledged.flatMap(sample => sample.hostedMs === undefined ? [] : [sample.hostedMs])), audits, verifications};
    const bytes = Buffer.from(JSON.stringify({...summary, samples}, null, 2) + "\n"), gz = gzipSync(bytes, {level: 9});
    await writeFile(resolve(artifact, "report.json.gz"), gz);
    await writeFile(resolve(artifact, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    await writeFile(resolve(artifact, "hashes.json"), JSON.stringify({reportSha256: hash(bytes), reportGzipSha256: hash(gz)}, null, 2) + "\n");
    console.log(JSON.stringify({runId: scope.runId, artifact, stopped, issued: samples.length, acknowledged: acknowledged.length, versionStable: versionBefore === versionAfter}));
    if (stopped !== null) process.exitCode = 1;
  }
}
if (process.argv.includes("--help")) console.log("bench:write --case hot|graph --count 1..10000: one explicitly authorized write burst to a fresh isolated graph; no retries or corpus repair");
else await main().catch(() => { console.error("Write benchmark stopped; inspect .artifacts/write-bench. No writes are retried."); process.exitCode = 1; });
