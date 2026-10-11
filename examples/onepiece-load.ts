import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

type WikiXmlParser = {
  on(event: "error", listener: (error: Error) => void): WikiXmlParser;
  on(event: "opentag" | "closetag", listener: (tag: Readonly<{ name: string }>) => void): WikiXmlParser;
  on(event: "text" | "cdata", listener: (text: string) => void): WikiXmlParser;
  write(chunk: string): WikiXmlParser;
  close(): WikiXmlParser;
};
type SaxesParserConstructor = new (options: { xmlns: boolean }) => WikiXmlParser;
const { SaxesParser } = createRequire(new URL("../poneglyph/package.json", import.meta.url))("saxes") as {
  SaxesParser: SaxesParserConstructor;
};

type TaggedValue =
  | Readonly<{ type: "text"; value: string }>
  | Readonly<{ type: "number"; value: string }>
  | Readonly<{ type: "boolean"; value: boolean }>
  | Readonly<{ type: "reference"; value: string }>;

type InputFact = Readonly<{
  source: string;
  entity: string;
  field: string;
  value: TaggedValue;
  retraction: false;
}>;

type MutablePage = { title: string; namespace: string; text: string; sawText: boolean };
type Capture = { tag: string; field: "title" | "namespace" | "text"; value: string };
type WikiPage = Readonly<{ title: string; namespace: string; text: string }>;
type QueryDefinition = Readonly<{ name: string; source: string; expectedRows?: number; minimumRows?: number }>;
type WorkerResponse = Record<string, unknown>;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PONEGLYPH_DIR = resolve(ROOT, "poneglyph");
const DEFAULT_XML_PATH = resolve(ROOT, "tests/fixtures/cache/onepiece-pages-current.xml");
const DEFAULT_ARCHIVE_PATH = resolve(ROOT, "tests/fixtures/cache/onepiece_pages_current.xml.7z");
const DUMP_PATH = process.env["PONEGLYPH_ONEPIECE_XML"] ?? DEFAULT_XML_PATH;
const ARCHIVE_PATH = process.env["PONEGLYPH_ONEPIECE_ARCHIVE"] ??
  (DUMP_PATH === DEFAULT_XML_PATH ? DEFAULT_ARCHIVE_PATH : `${DUMP_PATH}.7z`);
const MAX_PAGES = readNonNegativeInteger(process.env["PONEGLYPH_ONEPIECE_MAX_PAGES"], 5_000);
const QUERY_REPETITIONS = readPositiveInteger(process.env["PONEGLYPH_ONEPIECE_QUERIES"], 20);
const FACTS_PER_BATCH = 500;
const BATCH_JSON_BUDGET = 800_000;
const encoder = new TextEncoder();
type LocalWorker = Readonly<{ process: ChildProcess; readyUrl: Promise<string> }>;

const CREWS = [
  ["Straw Hat Pirates", "Monkey D. Luffy", "Roronoa Zoro"],
  ["Roger Pirates", "Gol D. Roger", "Silvers Rayleigh"],
  ["Red Hair Pirates", "Shanks", "Benn Beckman"],
  ["Whitebeard Pirates", "Edward Newgate", "Marco"],
  ["Kid Pirates", "Eustass Kid", "Killer"],
  ["Heart Pirates", "Trafalgar D. Water Law", "Bepo"],
] as const;

const ISLANDS = [
  ["Wano Country", "Kozuki Momonosuke"],
  ["Arabasta Kingdom", "Nefertari Cobra"],
  ["Dressrosa", "Riku Doldo III"],
  ["Fish-Man Island", "Neptune"],
  ["Drum Island", "Dalton"],
  ["Amazon Lily", "Boa Hancock"],
  ["Zou", "Inuarashi"],
] as const;

const LORE_CHAIN = [
  ["Joy Boy", "Nika"],
  ["Nika", "Gol D. Roger"],
  ["Gol D. Roger", "Shanks"],
  ["Shanks", "Monkey D. Luffy"],
] as const;

const QUERIES: readonly QueryDefinition[] = [
  {
    name: "captains_and_seconds",
    source: "wiki:crew:captain(Crew, Captain), wiki:crew:second(Crew, Second), " +
      "wiki:page:title(Crew, CrewName), wiki:page:title(Captain, CaptainName), " +
      "wiki:page:title(Second, SecondName)",
    minimumRows: CREWS.length,
  },
  {
    name: "islands_and_leaders",
    source: "wiki:island:leader(Island, Leader), wiki:page:title(Island, IslandName), " +
      "wiki:page:title(Leader, LeaderName)",
    minimumRows: ISLANDS.length,
  },
  {
    name: "joyboy_to_luffy_chain",
    source: 'wiki:lore:directConnection(A, B), wiki:lore:directConnection(B, C), ' +
      'wiki:lore:directConnection(C, D), wiki:lore:directConnection(D, E), ' +
      'wiki:page:title(A, "Joy Boy"), wiki:page:title(E, "Monkey D. Luffy")',
    expectedRows: 1,
  },
  {
    name: "people_with_d_name",
    source: 'wiki:page:type(Person, "character"), wiki:page:title(Person, Name), contains(Name, " D. ")',
  },
];

async function main(): Promise<void> {
  const file = await stat(DUMP_PATH).catch(() => undefined);
  if (file === undefined || !file.isFile()) {
    throw new Error(
      `One Piece XML is missing at ${DUMP_PATH}; run tests/fixtures/download_onepiece_fandom.sh ` +
      "or set PONEGLYPH_ONEPIECE_XML",
    );
  }

  const datasetHash = await sha256File(DUMP_PATH);
  const archiveFile = await stat(ARCHIVE_PATH).catch(() => undefined);
  const archiveHash = archiveFile === undefined ? undefined : await sha256File(ARCHIVE_PATH);
  const graphId = `onepiece-local-${randomUUID().slice(0, 8)}`;
  const persistenceDir = await mkdtemp(resolve(tmpdir(), "poneglyph-onepiece-local-"));
  const worker = startLocalWorker(persistenceDir);

  try {
    const baseUrl = await waitForWorker(graphId, worker);
    let batchNumber = 0;
    let factsQueued = 0;
    const loadStarted = performance.now();
    const ingest = await ingestDump(DUMP_PATH, MAX_PAGES, async (facts) => {
      batchNumber += 1;
      factsQueued += facts.length;
      await writeBatch(baseUrl, graphId, batchNumber, facts);
      if (batchNumber % 10 === 0) process.stderr.write(`Ingested ${batchNumber} transaction batches (${factsQueued} facts committed)\n`);
    });
    const loadElapsedMs = performance.now() - loadStarted;

    const results = await runQueries(baseUrl, graphId, batchNumber);
    const report = {
      runtime: "local workerd",
      graphId,
      dataset: {
        path: DUMP_PATH,
        xmlBytes: file.size,
        xmlSha256: datasetHash,
        ...(archiveFile === undefined ? {} : { archiveBytes: archiveFile.size, archiveSha256: archiveHash }),
        maxPages: MAX_PAGES === 0 ? "all" : MAX_PAGES,
        pagesLoaded: ingest.pages,
        factsCommitted: ingest.facts,
        transactions: batchNumber,
      },
      load: {
        elapsedMs: rounded(loadElapsedMs),
        factsPerSecond: rounded(ingest.facts / (loadElapsedMs / 1_000)),
      },
      queryRepetitions: QUERY_REPETITIONS,
      queries: results,
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await stopLocalWorker(worker.process);
    await rm(persistenceDir, { recursive: true, force: true });
  }
}

async function ingestDump(
  path: string,
  maxPages: number,
  write: (facts: readonly InputFact[]) => Promise<void>,
): Promise<Readonly<{ pages: number; facts: number }>> {
  const parser = new SaxesParser({ xmlns: false });
  const stack: string[] = [];
  let page: MutablePage | undefined;
  let capture: Capture | undefined;
  let pageCount = 0;
  let factCount = 0;
  let batch: InputFact[] = [];
  let batchBytes = 0;
  let writes = Promise.resolve();

  const flushBatch = (): void => {
    if (batch.length === 0) return;
    const ready = batch;
    batch = [];
    batchBytes = 0;
    writes = writes.then(() => write(ready));
  };

  const appendFact = (fact: InputFact): void => {
    const factBytes = encoder.encode(JSON.stringify(fact)).byteLength + 1;
    if (batch.length > 0 && (batch.length >= FACTS_PER_BATCH || batchBytes + factBytes > BATCH_JSON_BUDGET)) {
      flushBatch();
    }
    if (factBytes > BATCH_JSON_BUDGET) throw new Error("one generated One Piece fact exceeds the write budget");
    batch.push(fact);
    batchBytes += factBytes;
    factCount += 1;
  };

  const acceptPage = (candidate: MutablePage): void => {
    if (maxPages > 0 && pageCount >= maxPages) return;
    if (candidate.title.length === 0) return;
    const pageOrdinal = pageCount;
    pageCount += 1;
    for (const fact of pageFacts(candidate)) appendFact(fact);
    if (pageOrdinal % 10 === 0) {
      appendFact(makeFact(pageEntity(candidate.title), "wiki:page:sampled", { type: "boolean", value: true }));
    }
  };

  parser.on("error", (error) => { throw error; });
  parser.on("opentag", (tag) => {
    const name = tag.name;
    const parent = stack.at(-1);
    if (name === "page" && page === undefined) page = { title: "", namespace: "0", text: "", sawText: false };
    stack.push(name);

    if (page !== undefined && parent === "page" && (name === "title" || name === "ns")) {
      capture = { tag: name, field: name === "ns" ? "namespace" : "title", value: "" };
    } else if (page !== undefined && name === "text" && !page.sawText) {
      page.sawText = true;
      capture = { tag: name, field: "text", value: "" };
    }
  });
  const collectText = (text: string): void => {
    if (capture !== undefined) capture.value += text;
  };
  parser.on("text", collectText);
  parser.on("cdata", collectText);
  parser.on("closetag", (tag) => {
    if (capture !== undefined && capture.tag === tag.name && page !== undefined) {
      page[capture.field] = capture.value;
      capture = undefined;
    }
    if (tag.name === "page" && page !== undefined) {
      acceptPage(page);
      page = undefined;
    }
    stack.pop();
  });

  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 });
  let reachedPageLimit = false;
  for await (const chunk of stream) {
    parser.write(chunk);
    await writes;
    if (maxPages > 0 && pageCount >= maxPages) {
      reachedPageLimit = true;
      break;
    }
  }
  if (!reachedPageLimit) parser.close();
  flushBatch();
  appendFacts(domainFacts(), appendFact);
  flushBatch();
  await writes;

  return { pages: pageCount, facts: factCount };
}

function pageFacts(page: WikiPage): readonly InputFact[] {
  const entity = pageEntity(page.title);
  const facts: InputFact[] = [
    makeFact(entity, "wiki:page:title", { type: "text", value: page.title }),
    makeFact(entity, "wiki:page:namespace", { type: "number", value: page.namespace }),
    makeFact(entity, "wiki:page:text_bytes", { type: "number", value: String(Buffer.byteLength(page.text, "utf8")) }),
  ];

  const categories = take(wikiLinks(page.text, "Category:"), 8);
  for (const category of categories) facts.push(makeFact(entity, "wiki:page:category", { type: "text", value: category }));
  if (categories.some(isCharacterCategory)) facts.push(makeFact(entity, "wiki:page:type", { type: "text", value: "character" }));

  for (const link of take(wikiLinks(page.text, ""), 16)) {
    if (!link.startsWith("Category:")) facts.push(makeFact(entity, "wiki:page:link", { type: "text", value: link }));
  }
  return facts;
}

function appendFacts(facts: readonly InputFact[], append: (fact: InputFact) => void): void {
  for (const fact of facts) append(fact);
}

function domainFacts(): readonly InputFact[] {
  const source = "fixture:onepiece-fandom";
  const facts: InputFact[] = [];
  const titles = new Set<string>();
  for (const [crew, captain, second] of CREWS) titles.add(crew).add(captain).add(second);
  for (const [island, leader] of ISLANDS) titles.add(island).add(leader);
  for (const [from, to] of LORE_CHAIN) titles.add(from).add(to);
  for (const title of titles) facts.push(makeFact(pageEntity(title), "wiki:page:title", { type: "text", value: title }));

  for (const [crew, captain, second] of CREWS) {
    const entity = pageEntity(crew);
    facts.push(makeFact(entity, "wiki:crew:captain", { type: "reference", value: pageEntity(captain) }, source));
    facts.push(makeFact(entity, "wiki:crew:second", { type: "reference", value: pageEntity(second) }, source));
  }
  for (const [island, leader] of ISLANDS) {
    facts.push(makeFact(pageEntity(island), "wiki:island:leader", { type: "reference", value: pageEntity(leader) }, source));
  }
  for (const [from, to] of LORE_CHAIN) {
    facts.push(makeFact(pageEntity(from), "wiki:lore:directConnection", { type: "reference", value: pageEntity(to) }, source));
  }
  return facts;
}

function makeFact(entity: string, field: string, value: TaggedValue, source = "fixture:onepiece-fandom"): InputFact {
  return Object.freeze({ source, entity, field, value: Object.freeze(value), retraction: false });
}

function pageEntity(title: string): string {
  return `wiki:onepiece:page:${slugUriComponent(title)}`;
}

function slugUriComponent(value: string): string {
  let output = "";
  for (const character of value) {
    if (/[a-z0-9]/i.test(character)) output += character.toLowerCase();
    else if (character === " " || character === "_" || character === "-" || character === ":" || character === "/") output += "-";
  }
  return output.length === 0 ? "untitled" : output;
}

function* wikiLinks(text: string, prefix: string): Generator<string> {
  for (const match of text.matchAll(/\[\[([\s\S]*?)\]\]/g)) {
    const target = match[1]?.split("|")[0]?.trim();
    if (target !== undefined && target.length > 0 && target.startsWith(prefix)) yield target;
  }
}

function take<T>(values: Iterable<T>, limit: number): T[] {
  const result: T[] = [];
  for (const value of values) {
    result.push(value);
    if (result.length === limit) break;
  }
  return result;
}

function isCharacterCategory(category: string): boolean {
  return category.endsWith(" Characters") &&
    !category.includes("Portrait") &&
    !category.includes("Template");
}

async function writeBatch(baseUrl: string, graphId: string, sequence: number, facts: readonly InputFact[]): Promise<void> {
  const batch = {
    txId: `poneglyph:tx:onepiece-local:${graphId}:${sequence}`,
    facts,
  };
  const request = JSON.stringify(batch);
  if (encoder.encode(request).byteLength > 1_000_000) throw new Error(`transaction ${sequence} exceeds 1 MB`);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v1/graphs/${graphId}/transactions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: request,
      });
    } catch (error) {
      if (attempt === 4) throw error;
      await sleep(250 * (attempt + 1));
      continue;
    }

    if (response.status === 200) {
      const result = await response.json() as unknown;
      if (!isRecord(result) || result["txId"] !== batch.txId || result["status"] !== "committed" || result["commitSeq"] !== sequence) {
        throw new Error(`transaction ${sequence} returned an unexpected outcome: ${JSON.stringify(result)}`);
      }
      return;
    }
    const detail = await response.text();
    if (response.status !== 423 && response.status < 500) {
      throw new Error(`transaction ${sequence} rejected (${response.status}): ${detail}`);
    }
    if (attempt === 4) throw new Error(`transaction ${sequence} did not commit: ${response.status} ${detail}`);
    await sleep(250 * (attempt + 1));
  }
}

async function runQueries(baseUrl: string, graphId: string, expectedSnapshotSeq: number): Promise<readonly Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  for (const definition of QUERIES) {
    const first = await executeQuery(baseUrl, graphId, definition.source);
    if (first.snapshotSeq !== expectedSnapshotSeq) {
      throw new Error(`${definition.name} read snapshot ${first.snapshotSeq}; expected ${expectedSnapshotSeq}`);
    }
    verifyQueryRows(definition.name, first.rows);
    if (definition.expectedRows !== undefined && first.rows.length !== definition.expectedRows) {
      throw new Error(`${definition.name} returned ${first.rows.length} rows; expected exactly ${definition.expectedRows}`);
    }
    if (definition.minimumRows !== undefined && first.rows.length < definition.minimumRows) {
      throw new Error(`${definition.name} returned ${first.rows.length} rows; expected at least ${definition.minimumRows}`);
    }
    if (definition.name === "people_with_d_name" && first.rows.length === 0) {
      throw new Error("people_with_d_name returned no rows; use the full Fandom dump or include more pages");
    }

    const timings: number[] = [];
    for (let index = 0; index < QUERY_REPETITIONS; index += 1) {
      const started = performance.now();
      const repeated = await executeQuery(baseUrl, graphId, definition.source);
      timings.push(performance.now() - started);
      if (repeated.snapshotSeq !== first.snapshotSeq || repeated.rows.length !== first.rows.length) {
        throw new Error(`${definition.name} changed its snapshot or result count during read-only replay`);
      }
    }
    timings.sort((left, right) => left - right);
    results.push({
      name: definition.name,
      snapshotSeq: first.snapshotSeq,
      rows: first.rows.length,
      metrics: first.metrics,
      warmLatencyMs: {
        median: rounded(percentile(timings, 0.5)),
        p95: rounded(percentile(timings, 0.95)),
      },
    });
  }
  return results;
}

function verifyQueryRows(name: string, rows: readonly unknown[]): void {
  switch (name) {
    case "captains_and_seconds":
      assertIncludesBindings(rows, "CaptainName", ["Monkey D. Luffy", "Trafalgar D. Water Law"]);
      assertIncludesBindings(rows, "SecondName", ["Roronoa Zoro", "Bepo"]);
      return;
    case "islands_and_leaders":
      assertIncludesBindings(rows, "IslandName", ["Wano Country", "Dressrosa"]);
      assertIncludesBindings(rows, "LeaderName", ["Kozuki Momonosuke", "Neptune"]);
      return;
    case "joyboy_to_luffy_chain": {
      const row = rows[0];
      if (bindingString(row, "A") !== pageEntity("Joy Boy") || bindingString(row, "E") !== pageEntity("Monkey D. Luffy")) {
        throw new Error("joyboy_to_luffy_chain returned the wrong endpoints");
      }
      return;
    }
    case "people_with_d_name":
      if (rows.some((row) => !bindingString(row, "Name").includes(" D. "))) {
        throw new Error("people_with_d_name returned a row without the D. name marker");
      }
      return;
  }
}

function assertIncludesBindings(rows: readonly unknown[], variable: string, expected: readonly string[]): void {
  const values = new Set(rows.map((row) => bindingString(row, variable)));
  const missing = expected.filter((value) => !values.has(value));
  if (missing.length > 0) throw new Error(`query is missing ${variable} bindings: ${missing.join(", ")}`);
}

function bindingString(row: unknown, variable: string): string {
  if (!isRecord(row)) throw new Error("query binding row is malformed");
  const binding = row[variable];
  if (!isRecord(binding) || binding["type"] !== "string" || typeof binding["value"] !== "string") {
    throw new Error(`query binding ${variable} is not a string`);
  }
  return binding["value"];
}

async function executeQuery(baseUrl: string, graphId: string, query: string): Promise<Readonly<{
  rows: readonly unknown[];
  metrics: WorkerResponse["metrics"];
  snapshotSeq: number;
}>> {
  const response = await fetch(`${baseUrl}/v1/graphs/${graphId}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body: unknown = await response.json();
  if (!response.ok || !isRecord(body)) {
    throw new Error(`query rejected (${response.status}): ${JSON.stringify(body)}`);
  }
  const rows = body["rows"];
  const snapshotSeq = body["snapshotSeq"];
  if (!Array.isArray(rows) || typeof snapshotSeq !== "number" || !Number.isSafeInteger(snapshotSeq)) {
    throw new Error("query response is missing rows or a valid snapshot sequence");
  }
  return { rows, metrics: body["metrics"], snapshotSeq };
}

async function waitForWorker(graphId: string, worker: LocalWorker): Promise<string> {
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("local cf dev did not announce its address within 60 seconds")), 60_000);
    timeout.unref();
  });
  let baseUrl: string;
  try {
    baseUrl = await Promise.race([worker.readyUrl, expired]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }

  const deadline = Date.now() + 60_000;
  let lastError = "worker did not accept requests";
  while (Date.now() < deadline) {
    if (worker.process.exitCode !== null) {
      throw new Error(`local cf dev exited before startup (code ${worker.process.exitCode})`);
    }
    try {
      const response = await fetch(
        `${baseUrl}/v1/graphs/${graphId}/entities?uri=${encodeURIComponent("wiki:onepiece:page:smoke")}`,
      );
      if (response.ok) return baseUrl;
      lastError = `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`local cf dev did not become ready: ${lastError}`);
}

function startLocalWorker(persistenceDir: string): LocalWorker {
  const cf = resolve(PONEGLYPH_DIR, "node_modules/cf/bin/cf");
  let resolveReady!: (url: string) => void;
  let rejectReady!: (error: Error) => void;
  const readyUrl = new Promise<string>((resolveReadyUrl, rejectReadyUrl) => {
    resolveReady = resolveReadyUrl;
    rejectReady = rejectReadyUrl;
  });
  let announcedReady = false;
  let outputTail = "";
  const child = spawn(process.execPath, [cf, "dev", "--persist-to", persistenceDir], {
    cwd: PONEGLYPH_DIR,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const observeOutput = (chunk: Buffer): void => {
    const text = chunk.toString("utf8").replace(/\u001b\[[0-9;]*m/g, "");
    outputTail = `${outputTail}${text}`.slice(-4_096);
    const ready = /(?:Ready on|Local\s*:)\s*(https?:\/\/[^\s]+)/.exec(outputTail)?.[1];
    if (ready !== undefined && !announcedReady) {
      announcedReady = true;
      resolveReady(new URL(ready).origin);
    }
    process.stderr.write(chunk);
  };
  child.stdout?.on("data", observeOutput);
  child.stderr?.on("data", observeOutput);
  child.once("error", rejectReady);
  child.once("exit", (code, signal) => {
    if (!announcedReady) rejectReady(new Error(`cf dev exited before startup (code ${code ?? signal})`));
  });
  return Object.freeze({ process: child, readyUrl });
}

async function stopLocalWorker(worker: ChildProcess): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => worker.once("exit", () => resolveExit()));
  worker.kill("SIGTERM");
  await Promise.race([exited, sleep(5_000)]);
  if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("expected a positive integer environment value");
  return parsed;
}

function readNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("expected a non-negative integer environment value");
  return parsed;
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
