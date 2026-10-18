import {execFile} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {createServer} from "node:net";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {promisify} from "node:util";
import {gzipSync, gunzipSync} from "node:zlib";
import {setTimeout as sleep} from "node:timers/promises";
import {isRecord} from "@leostera/poneglyph/storage-protocol";
import {latencyStats, parseProbeResult, parseReadPlan, successful, transportFailure, type ReadPhase, type Sample} from "./plan.js";
import {settledWaves} from "./waves.js";
import type {ProbeRequest} from "./http2.js";
import {startReadPreview} from "./direct.js";

const execute = promisify(execFile), bench = import.meta.dirname, packageRoot = resolve(bench, "..");
const target = "poneglyph-mavplus-validation-worker", account = "0f436d2aabf1f872be90b8dd9d5715e6";
const environment = {...process.env, CLOUDFLARE_ACCOUNT_ID: account};
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function deployment() {
  let stdout: string;
  for (let attempt = 0; ; attempt++) {
    try {
      ({stdout} = await execute("cf", ["workers", "deployments", "list", "--worker", target, "--per-page", "1"], {env: environment, timeout: 30_000}));
      break;
    } catch (error) {
      // Only read-only control-plane metadata retries. Issued graph queries do not.
      if (attempt >= 2 || !isRecord(error) || typeof error["stderr"] !== "string" || !error["stderr"].includes("fetch failed")) throw new Error("Deployment metadata unavailable");
      await sleep(500);
    }
  }
  const raw: unknown = JSON.parse(stdout);
  if (!isRecord(raw) || !Array.isArray(raw["deployments"])) throw new Error("Invalid deployment response");
  const first: unknown = raw["deployments"][0];
  if (!isRecord(first) || !Array.isArray(first["versions"]) || first["versions"].length !== 1) throw new Error("Expected one deployed version");
  const version: unknown = first["versions"][0];
  if (!isRecord(version) || version["percentage"] !== 100 || typeof version["version_id"] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(version["version_id"])) throw new Error("Expected a stable 100-percent deployment");
  return version["version_id"];
}

async function availablePort(): Promise<number> {
  const server = createServer();
  return new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") { server.close(); reject(new Error("Invalid local listener")); return; }
      server.close(error => error ? reject(error) : accept(address.port));
    });
  });
}

async function query(kind: ReadPhase["kind"], runId: string, request: ProbeRequest, deadlineMs: number): Promise<Sample> {
  const started = performance.now();
  let response: Awaited<ReturnType<ProbeRequest>>, raw: unknown;
  try {
    response = await request(`/${kind}`, {method: "POST", signal: AbortSignal.timeout(deadlineMs)});
    raw = await response.json();
  } catch (error) { return {callerMs: performance.now() - started, failure: transportFailure(error)}; }
  try {
    const result = parseProbeResult(raw, runId);
    if (response.status !== (result.kind === "complete" ? 200 : 502)) throw new Error("Unexpected probe status");
    return {callerMs: performance.now() - started, result};
  } catch { return {callerMs: performance.now() - started, failure: "protocol"}; }
}

export async function runReadPhase(phase: ReadPhase, runId: string, request: ProbeRequest, deadlineMs = 30_000) {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000) throw new Error("Invalid probe deadline");
  const started = performance.now(), startedAt = new Date().toISOString(), launches: number[] = [];
  const {outcomes, observedMaxInFlight} = await settledWaves(phase, () => {
    launches.push(performance.now()); return query(phase.kind, runId, request, deadlineMs);
  }, wave => wave.every(outcome => outcome.status === "fulfilled" && successful(outcome.value)));
  const samples = outcomes.map((outcome): Sample => outcome.status === "fulfilled"
    ? outcome.value : {callerMs: outcome.elapsedMs, failure: "protocol"});
  const complete = samples.filter(successful), elapsedMs = performance.now() - started;
  return {phase, startedAt, elapsedMs, launchSpanMs: launches.length < 2 ? 0 : launches.at(-1)! - launches[0]!,
    observedMaxInFlight, issued: samples.length, successful: complete.length,
    failed: samples.length - complete.length, completeCallsPerSecond: complete.length / (elapsedMs / 1000),
    allOutcomeCallerMs: latencyStats(samples.map(sample => sample.callerMs)),
    successfulHostedCallerMs: latencyStats(complete.map(sample => sample.result.metrics.hostedMs)),
    successfulServiceMs: latencyStats(complete.map(sample => sample.result.metrics.serviceMs)),
    cacheHits: complete.reduce((sum, sample) => sum + sample.result.metrics.cacheHits, 0),
    completedResultHits: complete.filter(sample => sample.result.metrics.cacheHits === 1 && sample.result.metrics.leases === 0).length,
    samples};
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--plan")) throw new Error("Usage: bun run bench:read [--plan path.json]");
  const plan = parseReadPlan(JSON.parse(await readFile(args[1] ? resolve(args[1]) : resolve(bench, "small-plan.json"), "utf8")));
  const {stdout: cliVersionOutput} = await execute("cf", ["--version"], {env: environment, timeout: 10_000});
  const controlCliVersion = cliVersionOutput.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
  if (controlCliVersion === undefined) throw new Error("Invalid control CLI version");
  const runId = randomUUID(), versionBefore = await deployment();
  const {stdout: revision} = await execute("git", ["rev-parse", "HEAD"], {cwd: packageRoot});
  const {stdout: changes} = await execute("git", ["status", "--porcelain"], {cwd: packageRoot});
  const manifest = {runId, target, account, versionBefore, sourceRevision: revision.trim(), dirty: changes.trim() !== "",
    startedAt: new Date().toISOString(), nodeVersion: process.versions.node, controlCliVersion,
    callerMode: "direct-authenticated-preview-http2-native-service-binding", factWrites: 0,
    retries: 0, deadlineMs: 30_000, concurrencyBoundary: "offered-caller-not-simultaneous-backend-execution", plan};
  const artifact = resolve(packageRoot, ".artifacts/read-bench", runId); await mkdir(artifact, {recursive: true});
  await writeFile(resolve(artifact, "plan.json"), JSON.stringify({manifest, sha256: hash(JSON.stringify(manifest))}, null, 2) + "\n");
  const phases: Awaited<ReturnType<typeof runReadPhase>>[] = [];
  let stopped: "startup" | "execution" | "failure" | "deployment" | null = "startup";
  let operatorStartupColo = "unknown";
  let versionAfter: string | null = null, preview: Awaited<ReturnType<typeof startReadPreview>> | undefined;
  try {
    preview = await startReadPreview({artifact, runId, port: await availablePort(),
      concurrency: Math.max(...plan.phases.map(phase => Math.min(phase.count, phase.concurrency))), environment});
    for (let attempt = 0; ; attempt++) {
      if (attempt >= 3) throw new Error("Private preview not ready");
      try {
        const health = await preview.request("/health", {method: "GET", signal: AbortSignal.timeout(2_000)});
        const raw: unknown = await health.json();
        if (health.status !== 200 || !isRecord(raw) || raw["runId"] !== runId || raw["readOnly"] !== true) throw new Error("Invalid private preview identity");
        const colo = raw["startupColo"];
        if (typeof colo !== "string" || colo !== "unknown" && !/^[A-Z]{3}$/.test(colo)) throw new Error("Invalid probe location");
        operatorStartupColo = colo;
        break;
      } catch { await sleep(500); } // Readiness only; query attempts never repeat.
    }
    stopped = null;
    for (const phase of plan.phases) {
      stopped = "execution";
      const result = await runReadPhase(phase, runId, preview.request);
      // Retain all issued/settled samples before any further RPC/CLI diagnostic.
      await writeFile(resolve(artifact, `phase-${phases.length + 1}-settled.json.gz`), gzipSync(JSON.stringify(result)), {flag: "wx"});
      phases.push(result); stopped = null;
      const {samples: _samples, ...summary} = result; console.log(JSON.stringify(summary));
      if (result.failed) { stopped = "failure"; break; }
    }
    stopped ??= "deployment";
    versionAfter = await deployment();
    if (versionAfter === versionBefore && stopped === "deployment") stopped = null;
  } finally {
    try { await preview?.close(); } catch { stopped ??= "execution"; }
    const bytes = Buffer.from(JSON.stringify({manifest, operatorStartupColo, versionAfter, completedAt: new Date().toISOString(), stopped, phases}, null, 2) + "\n");
    const archive = gzipSync(bytes, {level: 9});
    if (!gunzipSync(archive).equals(bytes)) throw new Error("Report archive verification failed");
    await writeFile(resolve(artifact, "report.json.gz"), archive);
    await writeFile(resolve(artifact, "hashes.json"), JSON.stringify({reportSha256: hash(bytes), reportGzipSha256: hash(archive)}, null, 2) + "\n");
    console.log(JSON.stringify({runId, artifact, stopped, versionStable: versionAfter === versionBefore,
      issued: phases.reduce((sum, phase) => sum + phase.issued, 0), successful: phases.reduce((sum, phase) => sum + phase.successful, 0)}));
    if (stopped !== null) process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === "--help") console.log("bun run bench:read [--plan path.json]: explicit direct-HTTP/2 read-only private-preview run against the isolated synthetic fixture; no retries");
  else await main().catch(error => {
    const safeReasons = new Map([["Private preview unavailable", "preview-deadline"], ["Private preview stopped", "preview-stopped"],
      ["Invalid private preview authority", "preview-authority"], ["Private preview not ready", "preview-readiness"],
      ["H2 session unavailable", "h2-unavailable"], ["Insufficient H2 stream allocation", "h2-capacity"],
      ["Deployment metadata unavailable", "deployment-unavailable"], ["Expected a stable 100-percent deployment", "deployment-unstable"]]);
    console.error(JSON.stringify({event: "poneglyph.bench.read_stopped", reason: error instanceof Error ? safeReasons.get(error.message) ?? "unknown" : "unknown"}));
    process.exitCode = 1;
  });
}
