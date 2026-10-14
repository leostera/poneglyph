import { execFile } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { parseApprovedBatch, parseImportPlan } from "../src/import-contract.js";

// Explicit operator action for ONE unresolved original identity. Never invoked
// by the uploader, a default gate or a retry loop. Historical unknowns remain.
const hasSegmentArgument = process.argv[3] !== undefined;
const segment = hasSegmentArgument ? process.argv[2] : "pages10";
const ordinal = Number(hasSegmentArgument ? process.argv[3] : process.argv[2]);
if (segment !== "pages10" && segment !== "remainder90") throw new Error("Choose pages10 or remainder90");
if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error("Provide one original batch ordinal");
const directory = resolve(import.meta.dirname, `../.artifacts/import/${segment}`);
const stored = await readFile(resolve(directory, "manifest.json"), "utf8");
const planFile = segment === "pages10" ? "import-plan.json" : `import-plan-${segment}.json`;
if (stored !== await readFile(resolve(import.meta.dirname, `../src/${planFile}`), "utf8")) throw new Error("Approved plan mismatch");
const plan = parseImportPlan(JSON.parse(stored));
if (Date.now() >= Date.parse(plan.expiresAt)) throw new Error("Import window expired; no replacement IDs");
const records = (await readFile(resolve(directory, "journal.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
const last = records.at(-1);
const expected = plan.batches[ordinal];
if (!expected || !last || !["inflight", "stopped"].includes(last.phase) || last.batch !== ordinal
  || last.txId !== expected.txId || last.sha256 !== expected.sha256 || last.graphId !== plan.graphId || last.service !== plan.service) throw new Error("Not the unresolved original journal identity");
const file = resolve(directory, `${ordinal}.json`);
await parseApprovedBatch(await readFile(file), plan);
const journal = await open(resolve(directory, "journal.ndjson"), "a");
const append = async (fields: Record<string, unknown>) => {
  await journal.write(JSON.stringify({ at: new Date().toISOString(), service: plan.service, graphId: plan.graphId, batch: ordinal,
    txId: expected.txId, sha256: expected.sha256, reconciliation: "explicit-original-id", ...fields }) + "\n");
  await journal.sync();
};
try {
  await append({ phase: "inflight" });
  const { stdout } = await promisify(execFile)("cloudflared", ["access", "curl", "https://onepiece.poneglyph.dev/import", "--silent", "--show-error", "--max-time", "90",
    "-X", "POST", "-H", "Content-Type: application/json", "--data-binary", `@${file}`, "--write-out", "\n%{http_code}"], { timeout: 100_000, maxBuffer: 65_536 });
  const split = stdout.lastIndexOf("\n");
  const status = Number(stdout.slice(split + 1));
  const receipt: unknown = JSON.parse(stdout.slice(0, split));
  if (status !== 200 || typeof receipt !== "object" || receipt === null || !("txId" in receipt) || receipt.txId !== expected.txId
    || !("status" in receipt) || receipt.status !== "committed" || !("batch" in receipt) || receipt.batch !== ordinal
    || !("facts" in receipt) || receipt.facts !== expected.facts || !("commitSeq" in receipt)
    || typeof receipt.commitSeq !== "number" || !Number.isSafeInteger(receipt.commitSeq) || receipt.commitSeq <= 0) throw new Error("No valid original committed receipt");
  await append({ phase: "committed", receipt: { txId: expected.txId, commitSeq: receipt.commitSeq, status: "committed" }, facts: expected.facts, pages: expected.pages });
  console.log(JSON.stringify({ originalBatch: ordinal, txId: expected.txId, commitSeq: receipt.commitSeq, facts: expected.facts, reconciliation: "committed" }));
} catch (error) {
  await append({ phase: "stopped", delivery: "unknown", error: "Explicit original-ID reconciliation did not produce a valid receipt" });
  // Do not retain subprocess stderr, which may contain private login URLs.
  throw new Error("Original delivery remains unknown; reconciliation stopped without retry");
} finally { await journal.close(); }
