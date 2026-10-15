import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDatalogQuery, type DatalogQuery, type DatalogValue, type Term } from "@leostera/poneglyph";
import { QUERY_PREDICATE_INVENTORY, QUERY_RUBRIC } from "../src/query-rubric.js";

const site = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(site, "../..");
const corpusPath = resolve(root, "packages/write-path-bench/.data/facts.ndjson");
const checkpointPath = resolve(site, "evidence/2026-10-15-onepiece-million-fact-import-prefix.json");
const requestedCount = Number(argument("--count") ?? "50");
const hosted = process.argv.includes("--hosted");
const outputArg = argument("--out");
const accessEndpoint = "https://onepiece.poneglyph.dev/mcp";
const MAX_VALUE_MATCHES = 25;
const PACE_MS = 2_200;

if (!Number.isSafeInteger(requestedCount) || ![50, 100].includes(requestedCount)) {
  throw new Error("Query rubric batches are deliberately bounded to exactly 50 or 100 requests.");
}
if (hosted && !process.argv.includes("--confirm-read-only-hosted")) {
  throw new Error("Hosted mode requires --confirm-read-only-hosted; this runner sends 50 authenticated read-only queries.");
}

interface Tuple { readonly entity: string; readonly value: DatalogValue }
interface Relation {
  readonly all: Tuple[];
  readonly byEntity: Map<string, Tuple[]>;
  readonly byValue: Map<string, Tuple[]>;
}
interface ImportPrefix {
  readonly pages: number;
  readonly facts: number;
  readonly corpusPages: number;
  readonly corpusFacts: number;
  readonly factsSha256: string;
  readonly snapshotSeq: number | null;
  readonly retryOrdinal: number;
}
interface QueryCase {
  readonly key: string;
  readonly family: string;
  readonly predicate: string;
  readonly query: string;
  readonly clauses: number;
  readonly expected: readonly Row[];
}
interface QueryMetricsSample {
  readonly scanCalls: number;
  readonly shardRequests: number;
  readonly distinctShardsTouched: number;
  readonly treeReadLeaseAcquisitions: number;
  readonly tuplesRead: number;
  readonly bytesRead: number;
  readonly directoryRequests: number;
  readonly timing: Readonly<{executionMs: number; snapshotMs: number; evaluationMs: number; releaseMs: number}>;
}
interface SuccessfulSample {
  readonly index: number;
  readonly queryKey: string;
  readonly family: string;
  readonly outcome: "matched";
  readonly sent: true;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly clientRoundTripMs: number;
  readonly rows: number;
  readonly expectedRows: number;
  readonly rowSha256: string;
  readonly expectedRowSha256: string;
  readonly exactIndependentTypedMultiset: true;
  readonly snapshotSeq: number;
  readonly metrics: QueryMetricsSample;
}
interface FailedSample {
  readonly index: number;
  readonly queryKey: string;
  readonly family: string;
  readonly outcome: "error";
  readonly sent: boolean;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly clientRoundTripMs: number;
  readonly failure: string;
}
type BenchmarkSample = SuccessfulSample | FailedSample;
type TypedValue = Readonly<{type: "string" | "integer"; value: string}>;
type Row = Readonly<Record<string, TypedValue>>;
function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
function readJson(path: string): Record<string, any> { return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>; }
function delay(ms: number): Promise<void> { return new Promise(resolvePromise => setTimeout(resolvePromise, ms)); }
function valueKey(value: DatalogValue): string { return JSON.stringify([value.type, value.value]); }
function newRelation(): Relation { return {all: [], byEntity: new Map(), byValue: new Map()}; }
function appendIndex(map: Map<string, Tuple[]>, key: string, tuple: Tuple): void {
  const rows = map.get(key) ?? [];
  rows.push(tuple);
  map.set(key, rows);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function typedFactValue(value: Record<string, unknown>, field: string): DatalogValue {
  if (value["type"] === "text" && typeof value["value"] === "string") return {type: "string", value: value["value"]};
  if (value["type"] === "number" && typeof value["value"] === "string" && /^-?(0|[1-9][0-9]*)$/.test(value["value"])) {
    const integer = BigInt(value["value"]);
    assert.ok(integer >= -(1n << 63n) && integer <= (1n << 63n) - 1n, `${field} contains an out-of-range corpus integer`);
    return {type: "integer", value: integer.toString()};
  }
  throw new Error(`The normalized query corpus contains an unsupported scalar type for ${field}.`);
}
function parsePrefix(): ImportPrefix {
  const pages10Plan = readJson(resolve(site, ".artifacts/import/pages10/manifest.json"));
  const pages10Result = readJson(resolve(site, ".artifacts/import/pages10/result.json"));
  const remainderPlan = readJson(resolve(site, "src/import-plan-remainder90.json"));
  const checkpoint = readJson(checkpointPath);
  const corpusManifest = readJson(resolve(root, "packages/write-path-bench/.data/manifest.json"));
  const journal = readFileSync(resolve(site, ".artifacts/import/remainder90/journal.ndjson"), "utf8")
    .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, any>);

  assert.equal(pages10Plan.corpusSha256, corpusManifest.factsSha256);
  assert.equal(remainderPlan.corpusSha256, corpusManifest.factsSha256);
  assert.equal(checkpoint.corpus.factsSha256, corpusManifest.factsSha256);
  assert.equal(pages10Result.selectedPages, pages10Plan.selectedPages);
  assert.equal(pages10Result.selectedFacts, pages10Plan.selectedFacts);
  assert.equal(checkpoint.enrichment.importedFacts, 0, "the hosted oracle assumes no enrichment overlay");
  assert.equal(checkpoint.hostedBasePrefix.pages10.pages, pages10Plan.selectedPages);
  assert.equal(checkpoint.hostedBasePrefix.pages10.facts, pages10Plan.selectedFacts);

  const latestCommitted = new Map<number, Record<string, any>>();
  for (const record of journal) if (record["phase"] === "committed") latestCommitted.set(record["batch"], record);
  const remainderBatches = checkpoint.hostedBasePrefix.remainder90.committedContentBatches as number;
  const firstOrdinal = checkpoint.hostedBasePrefix.remainder90.ordinals[0] as number;
  const lastOrdinal = checkpoint.hostedBasePrefix.remainder90.ordinals[1] as number;
  assert.equal(firstOrdinal, 0);
  assert.equal(lastOrdinal + 1, remainderBatches);
  let remainderPages = 0, remainderFacts = 0;
  for (let ordinal = firstOrdinal; ordinal <= lastOrdinal; ordinal++) {
    const record = latestCommitted.get(ordinal);
    const planned = ordinal === remainderPlan.retry?.batch ? remainderPlan.retry : remainderPlan.batches[ordinal];
    assert.ok(record && planned, `missing committed receipt for remainder ordinal ${ordinal}`);
    assert.equal(record["txId"], planned.txId, `transaction identity mismatch at remainder ordinal ${ordinal}`);
    assert.equal(record["sha256"], planned.sha256, `body digest mismatch at remainder ordinal ${ordinal}`);
    assert.equal(record["facts"], planned.facts, `fact count mismatch at remainder ordinal ${ordinal}`);
    assert.equal(record["pages"], planned.pages, `page count mismatch at remainder ordinal ${ordinal}`);
    assert.equal(record["receipt"]?.status, "committed", `non-committed receipt at remainder ordinal ${ordinal}`);
    remainderPages += record["pages"] as number;
    remainderFacts += record["facts"] as number;
  }
  const pages = pages10Plan.selectedPages + remainderPages;
  const facts = pages10Plan.selectedFacts + remainderFacts;
  assert.equal(remainderPages, checkpoint.hostedBasePrefix.remainder90.pages);
  assert.equal(remainderFacts, checkpoint.hostedBasePrefix.remainder90.facts);
  assert.equal(pages, checkpoint.hostedBasePrefix.total.pages);
  assert.equal(facts, checkpoint.hostedBasePrefix.total.facts);
  assert.equal(pages, 227_692);
  assert.equal(facts, 1_096_908);

  return {
    pages,
    facts,
    corpusPages: corpusManifest.pages as number,
    corpusFacts: corpusManifest.facts as number,
    factsSha256: corpusManifest.factsSha256 as string,
    snapshotSeq: checkpoint.hostedBasePrefix.snapshotSeq as number | null,
    retryOrdinal: remainderPlan.retry.ordinal as number,
  };
}

async function loadOracle(prefix: ImportPrefix): Promise<Map<string, Relation>> {
  const fields = new Set<string>(QUERY_PREDICATE_INVENTORY.map(predicate => predicate.field));
  const relations = new Map<string, Relation>([...fields].map(field => [field, newRelation()]));
  const hash = createHash("sha256");
  let totalLines = 0, totalPages = 0, prefixFacts = 0, currentEntity = "";
  for await (const line of createInterface({input: createReadStream(corpusPath), crlfDelay: Infinity})) {
    hash.update(`${line}\n`);
    totalLines++;
    const fact: unknown = JSON.parse(line);
    assert.ok(isRecord(fact) && typeof fact["entity"] === "string" && typeof fact["field"] === "string" && isRecord(fact["value"]), "invalid normalized corpus fact");
    const field = fact["field"];
    if (field === "wiki:page:title") {
      totalPages++;
      currentEntity = fact["entity"] as string;
    }
    if (totalPages === 0) throw new Error("normalized corpus does not begin with a page title fact");
    if (totalPages > prefix.pages) continue;
    assert.equal(fact["entity"], currentEntity, "normalized corpus escaped a page boundary");
    assert.equal(fact["retraction"], false, "base corpus contains an unexpected retraction");
    assert.ok(fields.has(field), `unexpected predicate in normalized corpus: ${field}`);
    const relation = relations.get(field);
    assert.ok(relation);
    const rawValue = fact["value"] as Record<string, unknown>;
    const rawValues = rawValue["type"] === "list" ? rawValue["value"] : [rawValue];
    assert.ok(Array.isArray(rawValues));
    for (const item of rawValues) {
      assert.ok(isRecord(item));
      const value = typedFactValue(item, field);
      const tuple = {entity: fact["entity"] as string, value};
      relation.all.push(tuple);
      appendIndex(relation.byEntity, tuple.entity, tuple);
      appendIndex(relation.byValue, valueKey(tuple.value), tuple);
      prefixFacts++;
    }
  }
  assert.equal(totalLines, prefix.corpusFacts, "normalized corpus line count changed");
  assert.equal(totalPages, prefix.corpusPages, "normalized corpus page count changed");
  assert.equal(hash.digest("hex"), prefix.factsSha256, "normalized corpus SHA-256 changed");
  assert.equal(prefixFacts, prefix.facts, "the pinned hosted receipt prefix does not align with corpus page boundaries");
  return relations;
}

function pickEvenly<T>(values: readonly T[], count: number, label: string): T[] {
  assert.ok(values.length >= count, `not enough deterministic candidates for ${label}`);
  return Array.from({length: count}, (_, index) => values[Math.floor(index * (values.length - 1) / (count - 1))]!);
}
function valueLiteral(value: DatalogValue): string { return value.type === "string" ? JSON.stringify(value.value) : value.value; }
function relation(rels: Map<string, Relation>, field: string): Relation {
  const value = rels.get(field);
  assert.ok(value, `missing relation index for ${field}`);
  return value;
}

function makeCases(rels: Map<string, Relation>): QueryCase[] {
  const cases: QueryCase[] = [];
  for (const predicate of QUERY_PREDICATE_INVENTORY) {
    const rowsByEntity = relation(rels, predicate.field).byEntity;
    const candidates = [...rowsByEntity.keys()].filter(entity => rowsByEntity.get(entity)!.length > 0);
    for (const [index, entity] of pickEvenly(candidates, 5, `${predicate.field} entity bindings`).entries()) {
      const sampleRows = rowsByEntity.get(entity)!;
      const value = index === 0 ? valueLiteral(sampleRows[0]!.value) : "Value";
      const family = index === 0 ? "fully-bound-one-relation" : "entity-bound-one-relation";
      const query = `${predicate.field}(${JSON.stringify(entity)}, ${value})`;
      cases.push(makeCase(`entity-${predicate.field.replaceAll(":", "-")}-${index + 1}`, family, predicate.field, query, rels));
    }
  }

  for (const field of ["wiki:page:title", "wiki:page:category", "wiki:page:link", "wiki:page:text_bytes"]) {
    const candidates = [...relation(rels, field).byValue.entries()]
      .filter(([, rows]) => rows.length > 0 && rows.length <= MAX_VALUE_MATCHES)
      .map(([key]) => key);
    for (const [index, key] of pickEvenly(candidates, 5, `${field} value bindings`).entries()) {
      const rows = relation(rels, field).byValue.get(key)!;
      const query = `${field}(Page, ${valueLiteral(rows[0]!.value)})`;
      cases.push(makeCase(`value-${field.replaceAll(":", "-")}-${index + 1}`, "value-bound-one-relation", field, query, rels));
    }
  }

  const title = relation(rels, "wiki:page:title");
  const luffyRows = title.byValue.get(valueKey({type: "string", value: "Monkey D. Luffy"})) ?? [];
  assert.ok(luffyRows.length > 0, "Monkey D. Luffy must occur in the acknowledged corpus prefix");
  const luffy = luffyRows[0]!.entity;
  const category = relation(rels, "wiki:page:category");
  const memberCategory = "Category:Straw Hat Pirates Members";
  const memberCategoryRows = category.byValue.get(valueKey({type: "string", value: memberCategory})) ?? [];
  assert.ok(memberCategoryRows.length > 0 && memberCategoryRows.length <= MAX_VALUE_MATCHES, "member category must have a bounded populated result");
  const namespaceZero = relation(rels, "wiki:page:namespace").byValue.get(valueKey({type: "integer", value: "0"})) ?? [];
  assert.ok(namespaceZero.length > 0);
  const namespaceEntity = namespaceZero[0]!.entity;
  const joinQueries = [
    {key: "join-entity-title-namespace-equality", family: "two-relations-plus-integer-equality", predicate: "wiki:page:title+wiki:page:namespace", query: `wiki:page:title(${JSON.stringify(namespaceEntity)}, Title), wiki:page:namespace(${JSON.stringify(namespaceEntity)}, Namespace), Namespace = 0`},
    {key: "join-category-title-contains", family: "value-bound-two-relation-join-plus-string-builtin", predicate: "wiki:page:category+wiki:page:title", query: `wiki:page:category(Page, ${JSON.stringify(memberCategory)}), wiki:page:title(Page, Title), contains(Title, "o")`},

    {key: "join-link-resolution-three-relations", family: "three-relation-link-resolution", predicate: "wiki:page:title+wiki:page:link+wiki:page:title", query: `wiki:page:title(${JSON.stringify(luffy)}, "Monkey D. Luffy"), wiki:page:link(${JSON.stringify(luffy)}, TargetTitle), wiki:page:title(TargetPage, TargetTitle)`},
    {key: "join-link-human-category-filter", family: "four-relation-link-and-category-filter", predicate: "wiki:page:title+wiki:page:link+wiki:page:title+wiki:page:category", query: `wiki:page:title(${JSON.stringify(luffy)}, "Monkey D. Luffy"), wiki:page:link(${JSON.stringify(luffy)}, TargetTitle), wiki:page:title(TargetPage, TargetTitle), wiki:page:category(TargetPage, "Category:Humans")`},
    {key: "join-title-category-namespace-order", family: "three-relation-same-entity-join-plus-integer-range", predicate: "wiki:page:title+wiki:page:category+wiki:page:namespace", query: `wiki:page:title(Page, "Monkey D. Luffy"), wiki:page:category(Page, Category), wiki:page:namespace(Page, Namespace), Namespace >= 0`},
  ];
  for (const spec of joinQueries) cases.push(makeCase(spec.key, spec.family, spec.predicate, spec.query, rels));

  assert.equal(cases.length, 50, "the initial compliance and benchmark batch must contain exactly 50 queries");
  assert.equal(new Set(cases.map(item => item.key)).size, cases.length);
  return cases;
}

function makeCase(key: string, family: string, predicate: string, query: string, rels: Map<string, Relation>): QueryCase {
  const parsed = parseDatalogQuery(query);
  if (!parsed.ok) throw new Error(`rubric produced invalid Datalog for ${key}: ${parsed.error.message}`);
  return {key, family, predicate, query, clauses: parsed.value.facts.length + parsed.value.constraints.length, expected: evaluateOracle(parsed.value, rels)};
}

function resolveTerm(term: Term, binding: Map<string, DatalogValue>): DatalogValue | undefined {
  if (term.kind === "constant") return term.value;
  if (term.kind === "variable") return binding.get(term.name);
  return undefined;
}
function sameValue(left: DatalogValue, right: DatalogValue): boolean { return left.type === right.type && left.value === right.value; }
function compareValues(left: DatalogValue, right: DatalogValue): number | undefined {
  if (left.type !== right.type) return undefined;
  if (left.type === "integer") {
    const a = BigInt(left.value), b = BigInt(right.value);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const a = Array.from(left.value, character => character.codePointAt(0)!);
  const b = Array.from(right.value, character => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index++) if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}
function unify(term: Term, value: DatalogValue, binding: Map<string, DatalogValue>): boolean {
  if (term.kind === "wildcard") return true;
  if (term.kind === "constant") return sameValue(term.value, value);
  const previous = binding.get(term.name);
  if (previous) return sameValue(previous, value);
  binding.set(term.name, value);
  return true;
}
function constraintMatches(name: string, left: DatalogValue, right: DatalogValue): boolean {
  if (name === "=" || name === "eq") return sameValue(left, right);
  if (name === "contains") return left.type === "string" && right.type === "string" && left.value.includes(right.value);
  if (name === "startsWith") return left.type === "string" && right.type === "string" && left.value.startsWith(right.value);
  if (name === "endsWith") return left.type === "string" && right.type === "string" && left.value.endsWith(right.value);
  const comparison = compareValues(left, right);
  if (comparison === undefined) return false;
  if (name === "<" || name === "lt" || name === "before") return comparison < 0;
  if (name === "<=" || name === "lte") return comparison <= 0;
  if (name === ">" || name === "gt" || name === "after") return comparison > 0;
  if (name === ">=" || name === "gte") return comparison >= 0;
  throw new Error(`unsupported oracle constraint ${name}`);
}
function evaluateOracle(query: DatalogQuery, rels: Map<string, Relation>): Row[] {
  let bindings = [new Map<string, DatalogValue>()];
  for (const clause of query.facts) {
    const source = relation(rels, clause.predicate);
    const next: Map<string, DatalogValue>[] = [];
    for (const binding of bindings) {
      const entityValue = resolveTerm(clause.entity, binding);
      const factValue = resolveTerm(clause.value, binding);
      let candidates = source.all;
      if (entityValue?.type === "string") candidates = source.byEntity.get(entityValue.value) ?? [];
      if (factValue) {
        const byValue = source.byValue.get(valueKey(factValue)) ?? [];
        if (candidates.length === source.all.length || byValue.length < candidates.length) candidates = byValue;
      }
      for (const tuple of candidates) {
        const extended = new Map(binding);
        if (unify(clause.entity, {type: "string", value: tuple.entity}, extended) && unify(clause.value, tuple.value, extended)) next.push(extended);
      }
    }
    bindings = next;
  }
  bindings = bindings.filter(binding => query.constraints.every(constraint => {
    const left = resolveTerm(constraint.left, binding), right = resolveTerm(constraint.right, binding);
    return left !== undefined && right !== undefined && constraintMatches(constraint.name, left, right);
  }));
  return bindings.map(binding => Object.fromEntries([...binding.entries()].map(([name, value]) => [name, value])));
}
function canonicalBag(rows: readonly Row[]): string[] {
  return rows.map(row => JSON.stringify(Object.keys(row).sort().map(key => [key, row[key]!.type, row[key]!.value]))).sort();
}
function digestRows(rows: readonly Row[]): string { return createHash("sha256").update(JSON.stringify(canonicalBag(rows))).digest("hex"); }
function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)]!;
}
function int(value: unknown, field: string): number {
  assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, `query response omitted a valid ${field}`);
  return value;
}

function parseMcpPacket(body: string, contentType: string, id: string): Record<string, unknown> {
  if (!contentType.includes("event-stream")) return JSON.parse(body) as Record<string, unknown>;
  for (const line of body.split(/\r?\n/)) if (line.startsWith("data:")) {
    const packet: unknown = JSON.parse(line.slice(5).trim());
    if (isRecord(packet) && packet["id"] === id) return packet;
  }
  throw new Error("MCP event stream omitted its response packet; the query will not be retried.");
}
function queryData(packet: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(packet["error"])) throw new Error("MCP_JSON_RPC_ERROR");
  const result = packet["result"];
  if (!isRecord(result)) throw new Error("MCP_RESULT_MALFORMED");
  if (result["isError"] === true) {
    const content = result["content"];
    const textPart = Array.isArray(content) ? content.find(part => isRecord(part) && part["type"] === "text") : undefined;
    if (isRecord(textPart) && typeof textPart["text"] === "string") {
      try {
        const parsed: unknown = JSON.parse(textPart["text"]);
        if (isRecord(parsed) && isRecord(parsed["error"]) && typeof parsed["error"]["code"] === "string" && /^[a-z0-9_-]+$/.test(parsed["error"]["code"])) {
          throw new Error(`MCP_TOOL_ERROR:${parsed["error"]["code"]}`);
        }
      } catch (error) {
        if (error instanceof Error && /^MCP_TOOL_ERROR:[a-z0-9_-]+$/.test(error.message)) throw error;
      }
    }
    throw new Error("MCP_TOOL_ERROR:unknown");
  }
  if (isRecord(result["structuredContent"])) return result["structuredContent"];
  const content = result["content"];
  assert.ok(Array.isArray(content));
  const textPart = content.find(part => isRecord(part) && part["type"] === "text");
  assert.ok(isRecord(textPart) && typeof textPart["text"] === "string");
  const data: unknown = JSON.parse(textPart["text"]);
  assert.ok(isRecord(data));
  return data;
}
async function accessCookie(): Promise<string> {
  try {
    const path = process.env["PONEGLYPH_ACCESS_HELPER"] ?? resolve(process.env["HOME"] ?? "", ".pi/agent/bin/poneglyph-access-cookie.mjs");
    const helperOutput = execFileSync("node", [path], {
      encoding: "utf8", timeout: 120_000, maxBuffer: 16_000,
      env: {...process.env, PATH: `/tmp/poneglyph-access-safari:${process.env["PATH"] ?? ""}`},
    }).trim();
    if (!helperOutput.startsWith("CF_Authorization=")) throw new Error();
    return helperOutput;
  } catch {
    throw new Error("Access session unavailable; no hosted query was sent.");
  }
}

async function main(): Promise<void> {
  assert.ok(existsSync(corpusPath), "normalized source corpus is missing");
  const prefix = parsePrefix();
  const relations = await loadOracle(prefix);
  const uniqueCases = makeCases(relations);
  const repetitionsPerCase = requestedCount / uniqueCases.length;
  const cases = Array.from({length: repetitionsPerCase}, (_, repetition) => uniqueCases.map(spec => repetition === 0
    ? spec
    : {...spec, key: `${spec.key}-repeat-${repetition + 1}`})).flat();
  const batchId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const outputPath = resolve(outputArg ?? `${site}/evidence/query-rubric/${batchId}-onepiece-read-batch-${cases.length}.json`);
  if (existsSync(outputPath)) throw new Error("Evidence output already exists; choose a new output path instead of overwriting it.");

  const plan = {
    batchId,
    mode: hosted ? "hosted-read-only" : "local-plan-only",
    exactCount: cases.length,
    uniqueQueryCount: uniqueCases.length,
    repetitionsPerQuery: repetitionsPerCase,
    receiptPrefix: {pages: prefix.pages, facts: prefix.facts, corpusPages: prefix.corpusPages, corpusFacts: prefix.corpusFacts, corpusFactsSha256: prefix.factsSha256, baseRetryOrdinal: prefix.retryOrdinal, enrichmentFactsHosted: 0},
    inventory: {predicates: QUERY_PREDICATE_INVENTORY.map(predicate => predicate.field), bindingPatterns: QUERY_RUBRIC.bindings.map(binding => binding.id), builtins: QUERY_RUBRIC.builtins, hostedBuiltinExamples: ["integer equality", "integer range", "string contains"], relationCounts: [...relations.entries()].map(([field, index]) => ({field, tuples: index.all.length, distinctEntities: index.byEntity.size, distinctValues: index.byValue.size}))},
    cases: cases.map(({key, family, predicate, query, clauses, expected}) => ({key, family, predicate, query, clauses, expectedRows: expected.length, expectedRowsSha256: digestRows(expected)})),
  };
  if (!hosted) {
    console.log(JSON.stringify({...plan, note: `No credentials were read and no network request was sent. Add --hosted --confirm-read-only-hosted to send this ${cases.length}-request batch (${uniqueCases.length} unique queries, ${repetitionsPerCase} pass${repetitionsPerCase === 1 ? "" : "es"}).`}, null, 2));
    return;
  }

  const cookie = await accessCookie();
  const samples: BenchmarkSample[] = [];
  let previousStart = 0;
  for (const [index, spec] of cases.entries()) {
    const waitMs = Math.max(0, PACE_MS - (performance.now() - previousStart));
    if (index > 0 && waitMs > 0) await delay(waitMs);
    const id = `poneglyph-query-rubric-${batchId}-${index + 1}`;
    const startedAt = new Date().toISOString();
    previousStart = performance.now();
    const started = performance.now();
    let stage = "request";
    let sent = false;
    try {
      const response = await fetch(accessEndpoint, {
        method: "POST", cache: "no-store",
        headers: {Cookie: cookie, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25"},
        body: JSON.stringify({jsonrpc: "2.0", id, method: "tools/call", params: {name: "query", arguments: {query: spec.query}}}),
        signal: AbortSignal.timeout(30_000),
      });
      sent = true;
      stage = "http-response";
      const contentType = response.headers.get("content-type") ?? "";
      if (response.status !== 200 || !(contentType.includes("json") || contentType.includes("event-stream"))) {
        await response.body?.cancel();
        throw new Error(`HOSTED_HTTP_${response.status}`);
      }
      const body = await response.text();
      stage = "mcp-response";
      const packet = parseMcpPacket(body, contentType, id);
      const data = queryData(packet);
      const actual = data["rows"];
      assert.ok(Array.isArray(actual), "MCP_ROWS_MISSING");
      stage = "independent-result-comparison";
      if (JSON.stringify(canonicalBag(actual as Row[])) !== JSON.stringify(canonicalBag(spec.expected))) {
        throw new Error("INDEPENDENT_TYPED_RESULT_MISMATCH");
      }
      stage = "metrics-validation";
      const metrics = data["metrics"];
      assert.ok(isRecord(metrics), "QUERY_METRICS_MISSING");
      const normalizedMetrics: Record<string, number> = {};
      for (const field of ["scanCalls", "shardRequests", "distinctShardsTouched", "treeReadLeaseAcquisitions", "tuplesRead", "bytesRead", "directoryRequests"]) normalizedMetrics[field] = int(metrics[field], `metrics.${field}`);
      const timing = metrics["timing"];
      assert.ok(isRecord(timing), "QUERY_TIMING_MISSING");
      const normalizedTiming: Record<string, number> = {};
      for (const field of ["executionMs", "snapshotMs", "evaluationMs", "releaseMs"]) normalizedTiming[field] = int(timing[field], `metrics.timing.${field}`);
      const expectedLeaseCount = ["fully-bound-one-relation", "entity-bound-one-relation"].includes(spec.family) ? 1 : undefined;
      if (expectedLeaseCount !== undefined) {
        if (normalizedMetrics["treeReadLeaseAcquisitions"] !== expectedLeaseCount) throw new Error("TARGETED_READ_CUT_LEASE_COUNT_MISMATCH");
        if (normalizedMetrics["distinctShardsTouched"] !== 1) throw new Error("TARGETED_READ_CUT_SHARD_COUNT_MISMATCH");
      }
      const snapshotSeq = int(data["snapshotSeq"], "snapshotSeq");
      const clientRoundTripMs = Math.round((performance.now() - started) * 100) / 100;
      const metricsSample: QueryMetricsSample = {
        scanCalls: normalizedMetrics["scanCalls"]!, shardRequests: normalizedMetrics["shardRequests"]!,
        distinctShardsTouched: normalizedMetrics["distinctShardsTouched"]!, treeReadLeaseAcquisitions: normalizedMetrics["treeReadLeaseAcquisitions"]!,
        tuplesRead: normalizedMetrics["tuplesRead"]!, bytesRead: normalizedMetrics["bytesRead"]!, directoryRequests: normalizedMetrics["directoryRequests"]!,
        timing: {executionMs: normalizedTiming["executionMs"]!, snapshotMs: normalizedTiming["snapshotMs"]!, evaluationMs: normalizedTiming["evaluationMs"]!, releaseMs: normalizedTiming["releaseMs"]!},
      };
      const sample: SuccessfulSample = {
        index: index + 1, queryKey: spec.key, family: spec.family, outcome: "matched", sent: true,
        startedAt, completedAt: new Date().toISOString(), clientRoundTripMs, rows: actual.length, expectedRows: spec.expected.length,
        rowSha256: digestRows(actual as Row[]), expectedRowSha256: digestRows(spec.expected), exactIndependentTypedMultiset: true,
        snapshotSeq, metrics: metricsSample,
      };
      samples.push(sample);
      console.log(JSON.stringify({index: index + 1, queryKey: spec.key, outcome: "matched", clientRoundTripMs, rows: actual.length, shardRequests: metricsSample.shardRequests, distinctShardsTouched: metricsSample.distinctShardsTouched, treeReadLeaseAcquisitions: metricsSample.treeReadLeaseAcquisitions, snapshotMs: metricsSample.timing.snapshotMs, evaluationMs: metricsSample.timing.evaluationMs}));
    } catch (cause) {
      const clientRoundTripMs = Math.round((performance.now() - started) * 100) / 100;
      const message = cause instanceof Error ? cause.message : "";
      const failure = /^HOSTED_HTTP_[0-9]{3}$/.test(message) || /^MCP_TOOL_ERROR:[a-z0-9_-]+$/.test(message) || ["MCP_JSON_RPC_ERROR", "INDEPENDENT_TYPED_RESULT_MISMATCH", "TARGETED_READ_CUT_LEASE_COUNT_MISMATCH", "TARGETED_READ_CUT_SHARD_COUNT_MISMATCH"].includes(message)
        ? message
        : `${stage}:${cause instanceof Error ? cause.name : "UnknownError"}`;
      const sample: FailedSample = {index: index + 1, queryKey: spec.key, family: spec.family, outcome: "error", sent, startedAt, completedAt: new Date().toISOString(), clientRoundTripMs, failure};
      samples.push(sample);
      console.log(JSON.stringify({index: index + 1, queryKey: spec.key, outcome: "error", clientRoundTripMs, failure}));
    }
  }

  const matched = samples.filter((sample): sample is SuccessfulSample => sample.outcome === "matched");
  const families = [...new Set(cases.map(spec => spec.family))].map(family => {
    const attempts = samples.filter(sample => sample.family === family);
    const group = attempts.filter((sample): sample is SuccessfulSample => sample.outcome === "matched");
    const times = group.map(sample => sample.clientRoundTripMs);
    const phase = (name: keyof QueryMetricsSample["timing"]) => group.map(sample => sample.metrics.timing[name]);
    const summarize = (values: readonly number[]) => values.length ? {min: Math.min(...values), median: median(values), max: Math.max(...values)} : null;
    return {
      family, attempts: attempts.length, matched: group.length, failed: attempts.length - group.length,
      failureCodes: attempts.filter((sample): sample is FailedSample => sample.outcome === "error").map(sample => sample.failure),
      clientRoundTripMs: summarize(times),
      distinctShardsTouched: group.map(sample => sample.metrics.distinctShardsTouched),
      treeReadLeaseAcquisitions: group.map(sample => sample.metrics.treeReadLeaseAcquisitions),
      shardRequests: group.map(sample => sample.metrics.shardRequests),
      snapshotMs: summarize(phase("snapshotMs")),
      evaluationMs: summarize(phase("evaluationMs")),
    };
  });
  const complete = samples.length === cases.length;
  const allCasesMatched = complete && matched.length === cases.length;
  const evidence = {
    formatVersion: 1,
    observedAt: new Date().toISOString(),
    classification: "bounded 50-case hosted read-only query compliance and descriptive read-path benchmark; not capacity, tail-latency, full-corpus, or universal correctness certification",
    complete,
    allCasesMatched,
    hostedEndpoint: accessEndpoint,
    graph: {graphId: "onepiece", snapshotSeqMeaning: "snapshotSeq summarizes the leased owner vector; it is not a graph-global transaction clock"},
    source: prefix,
    inventory: plan.inventory,
    methodology: {caseCount: cases.length, uniqueQueryCount: uniqueCases.length, repetitionsPerQuery: repetitionsPerCase, requestsPerCase: 1, serial: true, minimumStartSpacingMs: PACE_MS, independentOracle: "typed multiset evaluation over the exact receipt-verified normalized corpus prefix", expectedMultisetSha256: "SHA-256 of sorted typed rows; duplicate rows retained", cpu: "not measured; no trace-sampling or deployment change was made", requestRetries: 0, perCaseFailures: "recorded and later cases continue; no failed query is automatically retried"},
    summaryByFamily: families,
    samples,
  };
  mkdirSync(dirname(outputPath), {recursive: true});
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {flag: "wx"});
  console.log(JSON.stringify({evidencePath: outputPath, complete, allCasesMatched, matchedCases: matched.length, failedCases: samples.length - matched.length, totalCases: cases.length}));
  if (!allCasesMatched) process.exitCode = 1;
}

await main();
