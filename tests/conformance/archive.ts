import assert from "node:assert/strict";
import {readFile, writeFile, unlink} from "node:fs/promises";
import {createHash} from "node:crypto";
import {gzipSync, gunzipSync} from "node:zlib";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

type CaseResult = {name: string; warm: string; cold: string; error?: string; coldError?: string; facts: number; graph: string};
type ArchivedRun = {kind: string; id: string; tier: string; gitRevision: string; runtime: unknown; suiteDigests: unknown; limitations: unknown;
  cases: string[]; implementations: {manifest: {implementation: string}; persistence: string; results: CaseResult[]}[]};
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Preserve every input/outcome/actual read byte losslessly, without committing
// tens of MB of repetitive JSON. Summaries never replace failing evidence.
export async function archiveReport(path: string) {
  const original = await readFile(path), report = JSON.parse(original.toString()) as ArchivedRun;
  assert.equal(report.kind, "correctness-conformance"); assert.ok(report.cases.length > 0);
  assert.equal(new Set(report.cases).size, report.cases.length);
  assert.deepEqual(report.implementations.map(i => i.manifest.implementation), ["A", "B1", "C", "D", "E", "F", "G", "H", "I", "J", "K"], "complete all-implementation traversal");
  const allowed = ["pass", "fail", "not-run", "unsupported", "inconclusive"];
  for (const implementation of report.implementations) {
    assert.deepEqual(implementation.results.map(result => result.name), report.cases, "no missing/extra/skipped cases");
    for (const result of implementation.results) {assert.ok(allowed.includes(result.warm)); assert.ok(allowed.includes(result.cold));}
  }
  const compressed = gzipSync(original, {level: 9}); assert.deepEqual(gunzipSync(compressed), original);
  const archive = `${path}.gz`; await writeFile(archive, compressed);
  assert.deepEqual(gunzipSync(await readFile(archive)), original, "retained archive verification");
  const summary = {...report, evidence: {file: "report.json.gz", uncompressedSha256: digest(original), compressedSha256: digest(compressed)},
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
