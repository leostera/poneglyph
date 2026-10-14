import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { parseApprovedBatch, parseImportPlan } from "../src/import-contract.js";

const directory = resolve(import.meta.dirname, "../.artifacts/import/pages10");
const stored = await readFile(resolve(directory, "manifest.json"), "utf8");
if (stored !== await readFile(resolve(import.meta.dirname, "../src/import-plan.json"), "utf8")) throw new Error("Operator and compiled approved plans disagree");
const plan = parseImportPlan(JSON.parse(stored));
if (Date.now() >= Date.parse(plan.expiresAt)) throw new Error("Import window expired; do not mint replacement IDs");
const journalPath = resolve(directory, "journal.ndjson");
const history = await readFile(journalPath, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
let next = 0, lastPhase: string | undefined;
for (const line of history.trim().split("\n").filter(Boolean)) {
  const record = JSON.parse(line);
  if (record.batch !== next || record.txId !== plan.batches[next]?.txId || record.sha256 !== plan.batches[next]?.sha256) throw new Error("Journal identity/order mismatch");
  if (record.phase === "committed") { next++; lastPhase = undefined; }
  else if (record.phase === "inflight" || record.phase === "stopped") lastPhase = record.phase;
  else throw new Error("Invalid journal phase");
}
if (lastPhase) throw new Error(`Unresolved original batch ${next}: explicit same-ID reconciliation is required, no automatic retry`);
const journal = await open(journalPath, "a");
const run = promisify(execFile);
let completed = false;
try {
  for (; next < plan.batches.length; next++) {
    const batch = plan.batches[next];
    const file = resolve(directory, `${next}.json`);
    const bytes = await readFile(file);
    await parseApprovedBatch(bytes, plan);
    const append = async (fields: Record<string, unknown>) => {
      await journal.write(JSON.stringify({ at: new Date().toISOString(), service: plan.service, graphId: plan.graphId, batch: next, txId: batch.txId, sha256: batch.sha256, ...fields }) + "\n");
      await journal.sync();
    };
    await append({ phase: "inflight" }); // durable original identity BEFORE send
    let stdout: string;
    try {
      ({ stdout } = await run("cloudflared", ["access", "curl", "https://onepiece.poneglyph.dev/import", "--silent", "--show-error", "--max-time", "90",
        "-X", "POST", "-H", "Content-Type: application/json", "--data-binary", `@${file}`, "--write-out", "\n%{http_code}"], { timeout: 100_000, maxBuffer: 65_536 }));
    } catch {
      await append({ phase: "stopped", delivery: "unknown", error: "Authenticated transport failed" });
      throw new Error(`Unknown delivery for original batch ${next}; stopped without retry`);
    }
    const split = stdout.lastIndexOf("\n");
    const status = Number(stdout.slice(split + 1));
    let response: Record<string, unknown>;
    try { response = JSON.parse(stdout.slice(0, split)); }
    catch {
      await append({ phase: "stopped", delivery: "unknown", httpStatus: status, error: "Invalid import reply" });
      throw new Error(`Unknown delivery for original batch ${next}; invalid reply`);
    }
    if (status !== 200 || response.status !== "committed" || response.txId !== batch.txId || response.batch !== next
      || response.facts !== batch.facts || !Number.isSafeInteger(response.commitSeq) || Number(response.commitSeq) <= 0) {
      await append({ phase: "stopped", delivery: response.delivery === "not-admitted" && status < 500 ? "not-admitted" : "unknown", httpStatus: status,
        error: typeof response.error === "string" ? response.error.slice(0, 256) : "Invalid receipt" });
      throw new Error(`Import stopped at original batch ${next}, HTTP ${status}; retain exact payload and reconcile explicitly`);
    }
    await append({ phase: "committed", receipt: { txId: batch.txId, commitSeq: response.commitSeq, status: "committed" }, facts: batch.facts, pages: batch.pages });
    console.log(JSON.stringify({ batch: next, batches: plan.batches.length, facts: batch.facts, commitSeq: response.commitSeq }));
    if (next + 1 < plan.batches.length) await sleep(1100); // serial backpressure, separate 60/min import bucket
  }
  completed = true;
} finally { await journal.close(); }
if (completed) {
  const journalHash = createHash("sha256").update(await readFile(journalPath)).digest("hex");
  const result = { at: new Date().toISOString(), service: plan.service, graphId: plan.graphId, selectedPages: plan.selectedPages, selectedFacts: plan.selectedFacts,
    acknowledgedBatches: next, corpusSha256: plan.corpusSha256, xmlSha256: plan.xmlSha256, source: plan.source, journalSha256: journalHash,
    scope: "All approved batches acknowledged; representative exact query verification is separate. Not full corpus or universal correctness certification." };
  await writeFile(resolve(directory, "result.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx", flush: true });
  console.log(JSON.stringify(result));
}
