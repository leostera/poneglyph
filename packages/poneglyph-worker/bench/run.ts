import {spawn, execFile} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import {mkdir, open, readFile, writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {createServer} from "node:net";
import {dirname, resolve} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {gzipSync, gunzipSync} from "node:zlib";
import {latencyStats, parseProbeResult, parseReadPlan, successful, transportFailure, type ReadPhase, type Sample} from "./plan.js";
import {settledWaves} from "./waves.js";

const execute = promisify(execFile);
const bench = dirname(fileURLToPath(import.meta.url)), packageRoot = resolve(bench, "..");
const target = "poneglyph-mavplus-validation-worker";
const baseUrl = "http://127.0.0.1:8879";
const port = 8879;
const account = "0f436d2aabf1f872be90b8dd9d5715e6";
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const environment = {...process.env, CLOUDFLARE_ACCOUNT_ID: account};

async function deployment() {
  const {stdout} = await execute("cf", ["workers", "deployments", "list", "--worker", target, "--per-page", "1"], {env: environment});
  const raw: unknown = JSON.parse(stdout);
  if (typeof raw !== "object" || raw === null || !("deployments" in raw) || !Array.isArray(raw.deployments)) throw new Error("Invalid deployment response");
  const first: unknown = raw.deployments[0];
  if (typeof first !== "object" || first === null || !("versions" in first) || !Array.isArray(first.versions) || first.versions.length !== 1) throw new Error("Expected one deployed version");
  const version: unknown = first.versions[0];
  if (typeof version !== "object" || version === null || !("percentage" in version) || version.percentage !== 100 ||
      !("version_id" in version) || typeof version.version_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(version.version_id)) throw new Error("Expected a stable 100-percent deployment");
  return version.version_id;
}

async function assertPortFree(): Promise<void> {
  const server = createServer();
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close(error => error ? reject(error) : accept()));
  });
}

async function waitForOperator(runId: string, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = performance.now() + 60_000;
  while (performance.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Private preview stopped before becoming ready");
    try {
      const response = await fetch(`${baseUrl}/health`, {signal: AbortSignal.timeout(2_000)});
      const raw: unknown = await response.json();
      if (response.status === 200 && typeof raw === "object" && raw !== null && "runId" in raw && raw.runId === runId) return;
    } catch { /* Only readiness probes repeat. Queries never retry. */ }
    await sleep(300);
  }
  throw new Error("Private preview did not become ready");
}

async function query(kind: ReadPhase["kind"], runId: string): Promise<Sample> {
  const started = performance.now();
  let response: Response;
  let raw: unknown;
  try {
    response = await fetch(`${baseUrl}/${kind}`, {method: "POST", signal: AbortSignal.timeout(30_000)});
    raw = await response.json();
  } catch (error) {
    return {callerMs: performance.now() - started, failure: transportFailure(error)};
  }
  try {
    const result = parseProbeResult(raw, runId);
    if (response.status !== (result.kind === "complete" ? 200 : 502)) throw new Error("Unexpected probe status");
    return {callerMs: performance.now() - started, result};
  } catch {
    return {callerMs: performance.now() - started, failure: "protocol"};
  }
}

async function runPhase(phase: ReadPhase, runId: string) {
  const started = performance.now(), startedAt = new Date().toISOString();
  const {outcomes, observedMaxInFlight} = await settledWaves(phase, () => query(phase.kind, runId),
    wave => wave.every(outcome => outcome.status === "fulfilled" && successful(outcome.value)));
  const samples = outcomes.map((outcome): Sample => outcome.status === "fulfilled"
    ? outcome.value : {callerMs: outcome.elapsedMs, failure: "protocol"});
  const complete = samples.filter(successful), elapsedMs = performance.now() - started;
  return {phase, startedAt, elapsedMs, observedMaxInFlight, issued: samples.length, successful: complete.length,
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
  await assertPortFree();
  const runId = randomUUID(), versionBefore = await deployment();
  const require = createRequire(import.meta.url), cfRequire = createRequire(require.resolve("cf/package.json"));
  const wrangler = resolve(dirname(cfRequire.resolve("wrangler/package.json")), "bin/wrangler.js");
  const {stdout: revision} = await execute("git", ["rev-parse", "HEAD"], {cwd: packageRoot});
  const {stdout: changes} = await execute("git", ["status", "--porcelain"], {cwd: packageRoot});
  const manifest = {runId, target, account, versionBefore, sourceRevision: revision.trim(), dirty: changes.trim() !== "",
    startedAt: new Date().toISOString(), callerMode: "private-preview-native-service-binding", writes: 0, retries: 0, plan};
  const artifact = resolve(packageRoot, ".artifacts/read-bench", runId);
  await mkdir(artifact, {recursive: true});
  await writeFile(resolve(artifact, "plan.json"), JSON.stringify({manifest, sha256: hash(JSON.stringify(manifest))}, null, 2) + "\n");
  const log = await open(resolve(artifact, "dev.log"), "w");
  const child = spawn(process.execPath, [wrangler, "dev", "--remote", "--experimental-new-config", "--port", String(port), "--ip", "127.0.0.1"], {
    cwd: bench, detached: true, stdio: ["ignore", log.fd, log.fd],
    env: {...environment, PONEGLYPH_READ_BENCH_RUN_ID: runId},
  });
  const exited = new Promise<void>(accept => { child.once("exit", () => accept()); child.once("error", () => accept()); });
  const phases: Awaited<ReturnType<typeof runPhase>>[] = [];
  let stopped: "startup" | "execution" | "failure" | "deployment" | null = "startup";
  let versionAfter: string | null = null;
  try {
    await waitForOperator(runId, child);
    stopped = null;
    for (const phase of plan.phases) {
      stopped = "execution";
      const result = await runPhase(phase, runId);
      stopped = null;
      phases.push(result);
      const {samples: _samples, ...summary} = result;
      console.log(JSON.stringify(summary));
      if (result.failed) { stopped = "failure"; break; }
    }
    stopped ??= "deployment";
    versionAfter = await deployment();
    if (versionAfter === versionBefore && stopped === "deployment") stopped = null;
  } finally {
    if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
    await Promise.race([exited, sleep(2_000)]);
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    await log.close();
    const bytes = Buffer.from(JSON.stringify({manifest, versionAfter, completedAt: new Date().toISOString(), stopped, phases}, null, 2) + "\n");
    const archive = gzipSync(bytes, {level: 9});
    if (!gunzipSync(archive).equals(bytes)) throw new Error("Report archive verification failed");
    await writeFile(resolve(artifact, "report.json.gz"), archive);
    await writeFile(resolve(artifact, "hashes.json"), JSON.stringify({reportSha256: hash(bytes),reportGzipSha256: hash(archive)}, null, 2) + "\n");
    console.log(JSON.stringify({runId, artifact, stopped, versionStable: versionAfter === versionBefore,
      issued: phases.reduce((sum, phase) => sum + phase.issued, 0), successful: phases.reduce((sum, phase) => sum + phase.successful, 0)}));
    if (stopped !== null) process.exitCode = 1;
  }
}

if (process.argv[2] === "--help") console.log("bun run bench:read [--plan path.json]: explicit read-only private-preview run against the isolated synthetic fixture; no retries");
else await main().catch(() => { console.error("Read benchmark stopped. Inspect its local .artifacts/read-bench report/dev.log, if created."); process.exitCode = 1; });
