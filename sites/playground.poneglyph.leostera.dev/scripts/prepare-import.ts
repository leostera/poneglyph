import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseFactDraft, parseUri, type FactDraft } from "@leostera/poneglyph";
import { IMPORT_BATCH_FACTS, IMPORT_BODY_BYTES, parseImportPlan, type ImportBatch } from "../src/import-contract.js";

// Explicit offline operator command, never called by build/check/test.
const site = resolve(import.meta.dirname, "..");
const corpus = resolve(site, "../../packages/write-path-bench/.data");
const expectedFactsHash = "e09d65047fe1479eacc7823761526d8280e3071d5c805ddf4b9bef43acb29064";
const expectedXmlHash = "1446ff8fca4bdebd289e5a546d67078d1170369fb3bfb65a35c758d53cd4e084";
const manifest = JSON.parse(await readFile(resolve(corpus, "manifest.json"), "utf8"));
if (manifest.factsSha256 !== expectedFactsHash || manifest.xmlSha256 !== expectedXmlHash
  || manifest.pages !== 296_624 || manifest.facts !== 1_530_195) throw new Error("Unexpected normalized corpus manifest");
const hash = createHash("sha256");
for await (const chunk of createReadStream(resolve(corpus, "facts.ndjson"))) hash.update(chunk);
if (hash.digest("hex") !== expectedFactsHash) throw new Error("Normalized corpus checksum mismatch");
const parsedSource = parseUri(`wiki:onepiece:dump:${expectedXmlHash}`);
if (!parsedSource.ok) throw new Error("Invalid corpus source identity");
const source = parsedSource.value;
const selectedPages = Math.floor(manifest.pages / 10);
const directory = resolve(site, ".artifacts/import/pages10");
await mkdir(directory, { recursive: true });
// Preparation cannot overwrite an already used plan/identities/window.
try { await readFile(resolve(directory, "manifest.json")); throw new Error("Existing import plan: reuse it, do not prepare again"); }
catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
const batches: ImportBatch[] = [];
let pending: FactDraft[] = [], pendingPages = 0;
let pages = 0, totalFacts = 0, selectedFacts = 0, currentEntity: string | undefined;
let current: FactDraft[] = [];
const seen = new Set<string>();
const witnesses: { entity: string; facts: readonly FactDraft[]; selection: string }[] = [];
function bodyFor(facts: readonly FactDraft[]) {
  return JSON.stringify({ batch: batches.length, txId: `wiki:import:${expectedFactsHash}:pages10:${batches.length}`, facts });
}
async function flushBatch() {
  if (!pending.length) return;
  const body = bodyFor(pending);
  const bytes = Buffer.byteLength(body);
  if (bytes > IMPORT_BODY_BYTES || pending.length > IMPORT_BATCH_FACTS) throw new Error("Unsupported whole-page batch");
  const batch = { txId: `wiki:import:${expectedFactsHash}:pages10:${batches.length}`, sha256: createHash("sha256").update(body).digest("hex"), facts: pending.length, pages: pendingPages, bytes };
  await writeFile(resolve(directory, `${batches.length}.json`), body, { flag: "wx" });
  batches.push(batch); pending = []; pendingPages = 0;
}
async function finishPage() {
  if (!currentEntity || pages > selectedPages) return;
  if (!current.length || current[0].field !== "wiki:page:title") throw new Error("Normalized page lacks first title fact");
  if (pages === 1 || pages === selectedPages || currentEntity === "wiki:onepiece:page:Monkey%20D.%20Luffy") {
    witnesses.push({ entity: currentEntity, facts: current, selection: pages === 1 ? "first" : pages === selectedPages ? "last" : "luffy" });
  }
  if (pending.length && (pending.length + current.length > IMPORT_BATCH_FACTS || Buffer.byteLength(bodyFor([...pending, ...current])) > IMPORT_BODY_BYTES)) await flushBatch();
  pending.push(...current); pendingPages++; selectedFacts += current.length;
}
const lines = createInterface({ input: createReadStream(resolve(corpus, "facts.ndjson")), crlfDelay: Infinity });
for await (const line of lines) {
  if (!line) throw new Error("Unexpected empty corpus record");
  const parsed = parseFactDraft(JSON.parse(line));
  if (!parsed.ok) throw new Error(`Invalid corpus fact: ${parsed.error.message}`);
  const fact = parsed.value;
  if (fact.source !== "fixture:onepiece-fandom" || fact.retraction) throw new Error("Unexpected corpus source/retraction");
  if (fact.field === "wiki:page:title") {
    await finishPage();
    pages++; currentEntity = fact.entity; current = [];
    if (pages <= selectedPages) {
      if (seen.has(fact.entity)) throw new Error("Duplicate title identity inside selected prefix");
      seen.add(fact.entity);
    }
  } else if (fact.entity !== currentEntity) throw new Error("Fact does not belong to the current normalized page");
  totalFacts++;
  if (pages <= selectedPages) current.push(Object.freeze({ ...fact, source }));
  else if (pages === selectedPages + 1 && fact.field === "wiki:page:title") witnesses.push({ entity: fact.entity, facts: [], selection: "first-excluded" });
}
await finishPage(); await flushBatch();
if (pages !== manifest.pages || totalFacts !== manifest.facts) throw new Error("Corpus counts disagree with manifest");
const openedAt = new Date();
const plan = parseImportPlan({ version: 1, graphId: "onepiece", service: "poneglyph-service-worker", corpusSha256: expectedFactsHash,
  xmlSha256: expectedXmlHash, source, totalPages: pages, selectedPages, selectedFacts, openedAt: openedAt.toISOString(),
  expiresAt: new Date(openedAt.getTime() + 2 * 86_400_000).toISOString(), batches });
await writeFile(resolve(directory, "witnesses.json"), JSON.stringify(witnesses, null, 2) + "\n", { flag: "wx" });
await writeFile(resolve(directory, "manifest.json"), JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
await writeFile(resolve(site, "src/import-plan.json"), JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ pages, selectedPages, selectedFacts, batches: batches.length, payloadBytes: batches.reduce((sum, b) => sum + b.bytes, 0), maxBatchFacts: Math.max(...batches.map(b => b.facts)), maxBatchBytes: Math.max(...batches.map(b => b.bytes)), expiresAt: plan.expiresAt, witnesses: witnesses.map(({ entity, selection }) => ({ entity, selection })), directory }));
