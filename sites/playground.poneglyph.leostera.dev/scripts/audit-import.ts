import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseFactDraft, parseUri, type FactDraft } from "@leostera/poneglyph";
import { parseApprovedBatch, parseImportPlan } from "../src/import-contract.js";

const segment = process.argv[2] ?? "pages10";
if (segment !== "pages10" && segment !== "remainder90") throw new Error("Choose pages10 or remainder90");
const site = resolve(import.meta.dirname, "..");
const corpus = resolve(site, "../../packages/write-path-bench/.data");
const directory = resolve(site, `.artifacts/import/${segment}`);
const planPath = resolve(site, `src/import-plan${segment === "pages10" ? "" : `-${segment}`}.json`);
const stored = await readFile(resolve(directory, "manifest.json"), "utf8");
if (stored !== await readFile(planPath, "utf8")) throw new Error("Operator and compiled approved plans disagree");
const plan = parseImportPlan(JSON.parse(stored));
if (plan.segment !== segment) throw new Error("Plan segment disagrees with the requested audit");
const parsedSource = parseUri(plan.source);
if (!parsedSource.ok) throw new Error("Invalid approved source identity");
const source = parsedSource.value;

const corpusHash = createHash("sha256");
for await (const chunk of createReadStream(resolve(corpus, "facts.ndjson"))) corpusHash.update(chunk);
if (corpusHash.digest("hex") !== plan.corpusSha256) throw new Error("Normalized corpus checksum mismatch");

let corpusPages = 0;
let corpusFacts = 0;
async function* selectedPages(): AsyncGenerator<readonly FactDraft[]> {
  const lines = createInterface({ input: createReadStream(resolve(corpus, "facts.ndjson")), crlfDelay: Infinity });
  let entity: string | undefined;
  let page: FactDraft[] = [];
  let includePage = false;
  const prefixPages = Math.floor(plan.totalPages / 10);
  const publishPage = async function* (): AsyncGenerator<readonly FactDraft[]> {
    if (includePage) yield page.map(fact => Object.freeze({ ...fact, source }));
  };
  for await (const line of lines) {
    if (!line) throw new Error("Unexpected empty corpus record");
    const parsed = parseFactDraft(JSON.parse(line));
    if (!parsed.ok || parsed.value.source !== "fixture:onepiece-fandom" || parsed.value.retraction) throw new Error("Unexpected normalized corpus fact");
    const fact = parsed.value;
    corpusFacts++;
    if (fact.field === "wiki:page:title") {
      if (entity !== undefined) yield* publishPage();
      corpusPages++;
      entity = fact.entity;
      includePage = segment === "pages10" ? corpusPages <= plan.selectedPages : corpusPages > prefixPages;
      page = [];
    } else if (fact.entity !== entity) throw new Error("Normalized fact escaped its page boundary");
    if (includePage) page.push(fact);
  }
  if (entity !== undefined) yield* publishPage();
}

const pages = selectedPages();
let expectedPage = await pages.next();
let expectedPageIndex = 0;
let comparedFacts = 0;
let comparedPages = 0;
for (let ordinal = 0; ordinal < plan.batches.length; ordinal++) {
  const metadata = plan.batches[ordinal]!;
  const bytes = await readFile(resolve(directory, `${ordinal}.json`));
  const approved = await parseApprovedBatch(bytes, plan);
  assert.equal(approved.ordinal, ordinal);
  assert.equal(approved.batch.facts.length, metadata.facts);
  assert.equal(approved.batch.facts[0]?.field, "wiki:page:title", "batches must begin at a whole-page boundary");
  let batchPages = 0;
  let currentEntity: string | undefined;
  for (const actual of approved.batch.facts) {
    if (actual.field === "wiki:page:title") {
      batchPages++;
      currentEntity = actual.entity;
    } else assert.equal(actual.entity, currentEntity, "page fact precedes its title boundary");
    while (expectedPage.done) throw new Error("Approved payload contains facts beyond the selected corpus pages");
    const expected = expectedPage.value[expectedPageIndex]!;
    assert.deepEqual(actual, expected, `fact mismatch at selected corpus fact ${comparedFacts}`);
    comparedFacts++;
    expectedPageIndex++;
    if (expectedPageIndex === expectedPage.value.length) {
      comparedPages++;
      expectedPage = await pages.next();
      expectedPageIndex = 0;
    }
  }
  assert.equal(batchPages, metadata.pages, "batch page count disagrees with its payload");
}
if (!expectedPage.done) throw new Error("Approved plan omitted selected corpus facts");
if (corpusPages !== plan.totalPages || corpusFacts !== 1_530_195 || comparedPages !== plan.selectedPages || comparedFacts !== plan.selectedFacts) {
  throw new Error("Corpus, plan and payload totals disagree");
}
console.log(JSON.stringify({ segment, corpusPages, corpusFacts, selectedPages: comparedPages, selectedFacts: comparedFacts,
  batches: plan.batches.length, payloadBytes: plan.batches.reduce((sum, batch) => sum + batch.bytes, 0), verified: true }));
