import assert from "node:assert/strict";
import {readFile, writeFile, unlink} from "node:fs/promises";
import {createHash} from "node:crypto";
import {gzipSync, gunzipSync} from "node:zlib";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {parseReply} from "./response-evidence.js";

type CaseResult = {name: string; warm: string; cold: string; error?: string; coldError?: string; facts: number; graph: string};
type ArchivedRun = Record<string, unknown> & {kind: string; id: string; tier: string; gitRevision: string; runtime: unknown; suiteDigests: unknown; limitations: unknown;
  cases: string[]; implementations: {manifest: Record<string, unknown> & {implementation: string}; persistence: string; results: CaseResult[]}[]};
const names = ["A", "B1", "C", "D", "E", "F", "G", "H", "I", "J", "K"];
function string(input: unknown): string {assert.ok(typeof input === "string"); return input;}
export function parseArchivedRun(input: unknown): ArchivedRun {
  const body = parseReply(input), cases = body["cases"], implementations = body["implementations"];
  assert.ok(Array.isArray(cases) && Array.isArray(implementations));
  return {...body, kind: string(body["kind"]), id: string(body["id"]), tier: string(body["tier"]), gitRevision: string(body["gitRevision"]),
    runtime: body["runtime"], suiteDigests: body["suiteDigests"], limitations: body["limitations"], cases: cases.map(string),
    implementations: implementations.map(raw => {
      const actor = parseReply(raw), manifest = parseReply(actor["manifest"]), results = actor["results"];
      assert.ok(Array.isArray(results));
      return {manifest: {...manifest, implementation: string(manifest["implementation"])}, persistence: string(actor["persistence"]), results: results.map(raw => {
        const row = parseReply(raw), facts = row["facts"];
        assert.ok(typeof facts === "number" && Number.isSafeInteger(facts) && facts >= 0);
        return {...row, name: string(row["name"]), warm: string(row["warm"]), cold: string(row["cold"]), facts, graph: string(row["graph"]),
          error: row["error"] === undefined ? undefined : string(row["error"]), coldError: row["coldError"] === undefined ? undefined : string(row["coldError"])};
      })};
    })};
}
export function validateTraversal(report: ArchivedRun) {
  const execution = report["execution"] === undefined ? undefined : parseReply(report["execution"]);
  const stopped = execution?.["policy"] === "fail-fast" && execution["status"] === "stopped";
  const observed = report.implementations.map(i => i.manifest.implementation);
  assert.deepEqual(observed, stopped ? names.slice(0, observed.length) : names, "ordered all-backend traversal or explicit failed prefix");
  assert.ok(observed.length <= names.length);
  if (execution) {
    assert.equal(execution["policy"], "fail-fast");
    assert.ok(execution["status"] === "complete" || stopped, "never archive an unfinished run as terminal");
    if (stopped) {const failure = parseReply(execution["firstFailure"]); assert.ok(names.includes(string(failure["implementation"]))); string(failure["error"]);}
    else assert.equal(execution["firstFailure"], null);
  }
  let failedCases = 0;
  for (const [index, implementation] of report.implementations.entries()) {
    const partial = stopped && index === report.implementations.length - 1;
    assert.deepEqual(implementation.results.map(result => result.name), partial ? report.cases.slice(0, implementation.results.length) : report.cases, "no missing/extra cases except a recorded failed tail");
    assert.ok(implementation.results.length <= report.cases.length);
    let failed = false;
    for (const status of [...implementation.results.map(r => r.warm), ...implementation.results.map(r => r.cold)]) {
      if (execution && failed) assert.equal(status, "not-run", "no execution after the first failed case");
      if (status === "fail") failed = true;
    }
    for (const result of implementation.results) {
      const allowed = execution ? ["pass", "fail", "not-run"] : ["pass", "fail", "not-run", "unsupported", "inconclusive"];
      assert.ok(allowed.includes(result.warm) && allowed.includes(result.cold));
      if (execution && !partial) assert.ok(result.warm === "pass" && result.cold === "pass", "no earlier failed or unexecuted backend");
      if (result.warm === "fail" || result.cold === "fail") failedCases++;
    }
  }
  if (stopped) {
    assert.ok(failedCases <= 1, "fail-fast cannot continue through additional case failures");
    assert.ok(execution);
    const failure = parseReply(execution["firstFailure"]), phase = failure["phase"];
    if (phase === "warm" || phase === "cold") {
      assert.equal(failedCases, 1, "case failure has exact retained evidence");
      const actor = report.implementations.at(-1); assert.ok(actor);
      assert.equal(actor.manifest.implementation, failure["implementation"]);
      const result = actor.results.find(result => result.name === failure["caseName"]); assert.ok(result);
      assert.equal(phase === "warm" ? result.warm : result.cold, "fail");
    }
  }
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Preserve every input/outcome/actual read byte losslessly, without committing
// tens of MB of repetitive JSON. Summaries never replace failing evidence.
export async function archiveReport(path: string) {
  const original = await readFile(path), report = parseArchivedRun(JSON.parse(original.toString()));
  assert.equal(report.kind, "correctness-conformance"); assert.ok(report.cases.length > 0);
  assert.equal(new Set(report.cases).size, report.cases.length);
  validateTraversal(report);
  const compressed = gzipSync(original, {level: 9}); assert.deepEqual(gunzipSync(compressed), original);
  const archive = `${path}.gz`; await writeFile(archive, compressed);
  assert.deepEqual(gunzipSync(await readFile(archive)), original, "retained archive verification");
  const executedPhases = report.implementations.reduce((count, i) => count + i.results.reduce((n, r) => n + Number(r.warm === "pass" || r.warm === "fail") + Number(r.cold === "pass" || r.cold === "fail"), 0), 0);
  const summary = {...report, plannedImplementations: names, executedPhases, unexecutedPhases: names.length * report.cases.length * 2 - executedPhases, evidence: {file: "report.json.gz", uncompressedSha256: digest(original), compressedSha256: digest(compressed)},
    implementations: report.implementations.map(i => ({manifest: i.manifest, persistence: i.persistence,
      warmPassed: i.results.filter(r => r.warm === "pass").length, coldPassed: i.results.filter(r => r.cold === "pass").length,
      results: i.results.map(({name, warm, cold, error, coldError, facts, graph}) => ({name, warm, cold, error, coldError, facts, graph}))}))};
  // Caller traces and actual query rows remain in the lossless full archive.
  await writeFile(resolve(dirname(path), "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  await unlink(path); // Only after the lossless archive was reread and verified.
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  for (const path of process.argv.slice(2)) await archiveReport(resolve(path));
}
