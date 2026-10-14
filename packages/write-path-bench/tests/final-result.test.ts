import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { saveFinalResult } from "../final-result.js";

test("final retention saves measurements and audits before removing intermediates", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "poneglyph-final-result-"));
  const reports = resolve(directory, "reports"), artifacts = resolve(directory, "raw");
  await mkdir(reports); await mkdir(artifacts);
  try {
    await writeFile(resolve(reports, "manifest.json"), JSON.stringify({ selected: ["parallel-medium"], artifacts }));
    await writeFile(resolve(reports, "summary.json"), JSON.stringify({ status: "running" }));
    await writeFile(resolve(reports, "parallel-medium.json"), JSON.stringify({
      stage: "complete", metrics: { acknowledgedFacts: 100000, interval: [{ elapsedMs: 1 }] },
      audit: { valid: true }, restartAudit: { valid: true }, journal: { file: "raw.gz" },
    }));
    await writeFile(resolve(reports, "raw.gz"), "intermediate fixture");
    await assert.rejects(saveFinalResult(reports, artifacts), /unfinished/);
    await stat(artifacts);
    await writeFile(resolve(reports, "summary.json"), JSON.stringify({ status: "complete" }));
    await saveFinalResult(reports, artifacts);
    assert.deepEqual(await readdir(reports), ["final.json"]);
    const final = JSON.parse(await readFile(resolve(reports, "final.json"), "utf8"));
    assert.equal(final.scenarios[0].metrics.acknowledgedFacts, 100000);
    assert.deepEqual(final.scenarios[0].audit, { valid: true });
    assert.deepEqual(final.scenarios[0].restartAudit, { valid: true });
    assert.equal(final.scenarios[0].metrics.interval, undefined);
    assert.equal(final.scenarios[0].journal, undefined);
    await assert.rejects(stat(artifacts), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
