import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildWorkers } from "../build.js";
import { AuditLedger, corpusBatches, prepareReference } from "../ledger.js";
import { verifyStream } from "../stream-audit.js";
import { startLocal } from "../runtime.js";
import { drive } from "../driver.js";

test("streamed batches and disk-backed audit preserve duplicate facts and survive database restart", { timeout: 120000 }, async () => {
  await buildWorkers();
  const directory = await mkdtemp(resolve(tmpdir(), "poneglyph-streamed-bench-"));
  const input = resolve(directory, "facts.ndjson"), reference = resolve(directory, "reference.sqlite");
  const facts = Array.from({ length: 201 }, (_, i) => ({ source: "bench:stream-fixture", entity: `wiki:person:${i % 20}`,
    field: i % 31 === 0 ? "wiki:page:namespace" : "wiki:person:name",
    value: i % 31 === 0 ? { type: "number", value: "6" } : { type: "text", value: `Person ${i % 20}` }, retraction: false }));
  await writeFile(input, facts.map(fact => JSON.stringify(fact)).join("\n") + "\n");
  assert.equal((await prepareReference(input, reference, 201)).facts, 201);
  const ledger = new AuditLedger(resolve(directory, "audit.sqlite"), reference, "bench:streamed", 201, 10);
  let runtime = await startLocal("bench-streamed", resolve(directory, "storage"), 4);
  try {
    const result = await drive(corpusBatches(input, 201, 10, "bench:streamed"), { name: "streamed", batchSize: 10, concurrency: 10 },
      { endpoints: runtime.endpoints, token: runtime.token, maxAttempts: 12, attemptTimeoutMs: 30000,
        journal: resolve(directory, "outcomes.ndjson"), collectOutcomes: false, onOutcome: outcome => ledger.recordOutcome(outcome) });
    assert.equal(result.outcomes.length, 0, "full workload should not retain response objects in memory");
    assert.equal(result.metrics.plannedCallsAttempted, 21);
    assert.equal(result.metrics.acknowledgedFacts, 201);
    await runtime.waitForIdle();
    const audit = await verifyStream(runtime, ledger);
    assert.equal(audit.persistedFacts, 201); assert.equal(audit.activeTuples, 27); assert.equal(audit.allFactsPersisted, true);
    const token = runtime.token;
    await runtime.mf.dispose(); runtime = await startLocal("bench-streamed", resolve(directory, "storage"), 4, token);
    assert.equal((await verifyStream(runtime, ledger)).persistedFacts, 201);
  } finally { await runtime.mf.dispose(); ledger.close(); await rm(directory, { recursive: true, force: true }); }
});
