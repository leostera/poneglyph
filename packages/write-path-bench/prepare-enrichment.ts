import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFactDraft } from "@leostera/poneglyph";
import { ROOT } from "./build.js";
import {
  classifyOnePiecePage,
  extractPageEnrichment,
  identityFacts,
  type ExtractionIssue,
} from "./onepiece-enrichment.js";
import type { OnePieceEntityKind } from "./onepiece-identities.js";
import { WikiPageDirectory } from "./wiki-page-directory.js";
import { visitMediaWikiPages, type WikiDumpPage } from "./wiki-xml.js";

const DEFAULT_XML = resolve(ROOT, "../../tests/fixtures/cache/onepiece_pages_current.xml");
const DEFAULT_CORPUS_MANIFEST = resolve(ROOT, ".data/manifest.json");
const ENTITY_KINDS: readonly OnePieceEntityKind[] = ["entity", "character", "crew", "ship", "organization", "role"];

type CorpusManifest = Readonly<{ xmlSha256: string; pages: number }>;
type IssueSummary = Readonly<{ counts: Readonly<Record<string, number>>; samples: readonly ExtractionIssue[] }>;

export type EnrichmentPreparationResult = Readonly<{
  outputDirectory: string;
  inputXmlSha256: string;
  pages: number;
  facts: number;
  factsSha256: string;
  entitiesByKind: Readonly<Record<string, number>>;
  factsByField: Readonly<Record<string, number>>;
  issues: Readonly<Record<string, number>>;
}>;

export async function prepareOnePieceEnrichment(
  xmlPath = DEFAULT_XML,
  corpusManifestPath = DEFAULT_CORPUS_MANIFEST,
  outputDirectory?: string,
): Promise<EnrichmentPreparationResult> {
  const expectedSource = parseCorpusManifest(JSON.parse(await readFile(corpusManifestPath, "utf8")) as unknown);
  const finalDirectory = resolve(outputDirectory ?? resolve(ROOT, `.data/onepiece-enrichment-v5-${expectedSource.xmlSha256.slice(0, 12)}`));
  await ensurePathAbsent(finalDirectory);
  await mkdir(dirname(finalDirectory), { recursive: true });

  const temporaryDirectory = resolve(dirname(finalDirectory), `.${basename(finalDirectory)}.partial-${process.pid}-${randomUUID()}`);
  await mkdir(temporaryDirectory, { recursive: false });
  const issuesOutput = createWriteStream(resolve(temporaryDirectory, "issues.ndjson"), { flags: "wx" });
  let factsOutput: WriteStream | undefined;
  const issueCounts = new Map<string, number>();
  const issueSamples: ExtractionIssue[] = [];
  const addIssue = async (issue: ExtractionIssue): Promise<void> => {
    issueCounts.set(issue.kind, (issueCounts.get(issue.kind) ?? 0) + 1);
    if (issueSamples.length < 100) issueSamples.push(issue);
    await writeJsonLine(issuesOutput, issue);
  };

  try {
    const directory = new WikiPageDirectory();
    const kindByPageId = new Map<string, OnePieceEntityKind>();
    const kindEvidenceByPageId = new Map<string, readonly string[]>();
    const firstPass = await visitMediaWikiPages(createReadStream(xmlPath), async page => {
      directory.add(pageReference(page));
      if (page.namespace !== "0") return;
      const classification = classifyOnePiecePage(page);
      if (kindByPageId.has(page.id)) {
        kindByPageId.set(page.id, "entity");
        kindEvidenceByPageId.set(page.id, Object.freeze([]));
        await addIssue(Object.freeze({
          kind: "identity-conflict", pageId: page.id, title: page.title,
          message: "MediaWiki page ID occurs more than once in the source dump; semantic identity is withheld",
        }));
      } else {
        kindByPageId.set(page.id, classification.kind);
        kindEvidenceByPageId.set(page.id, classification.issues.some(issue => issue.kind === "identity-conflict")
          ? Object.freeze([]) : classification.evidence);
      }
      for (const issue of classification.issues) await addIssue(issue);
    });
    if (firstPass.sha256 !== expectedSource.xmlSha256 || firstPass.pages !== expectedSource.pages) {
      throw new Error(`XML input does not match the pinned normalized-corpus manifest: sha256=${firstPass.sha256}, pages=${firstPass.pages}`);
    }
    const directoryAudit = directory.audit();
    const classificationCounts = countValues(kindByPageId.values());

    const factsFile = createWriteStream(resolve(temporaryDirectory, "facts.ndjson"), { flags: "wx" });
    factsOutput = factsFile;
    const factsHash = createHash("sha256");
    const emittedEntityIds = new Set<string>();
    const entitiesByKind = new Map<string, number>();
    const factsByField = new Map<string, number>();
    let factCount = 0;
    let factBytes = 0;
    const addFact = async (candidate: Parameters<typeof parseFactDraft>[0]): Promise<void> => {
      const parsed = parseFactDraft(candidate);
      if (!parsed.ok) throw new TypeError(`generated enrichment fact is invalid: ${parsed.error.message}`);
      const line = `${JSON.stringify(parsed.value)}\n`;
      const bytes = Buffer.from(line, "utf8");
      factsHash.update(bytes);
      factBytes += bytes.byteLength;
      factCount++;
      factsByField.set(parsed.value.field, (factsByField.get(parsed.value.field) ?? 0) + 1);
      if (!factsFile.write(bytes)) await once(factsFile, "drain");
    };

    for (const kind of ENTITY_KINDS) {
      if ((classificationCounts[kind] ?? 0) === 0) continue;
      await addFact({
        source: `wiki:onepiece:derived:${firstPass.sha256}:vocabulary-v5`,
        entity: `onepiece:kind:${kind}`,
        field: "onepiece:name",
        value: { type: "text", value: kind },
        retraction: false,
      });
    }

    const secondPass = await visitMediaWikiPages(createReadStream(xmlPath), async page => {
      const enrichment = extractPageEnrichment(page, directory, kindByPageId, firstPass.sha256);
      for (const issue of enrichment.issues) await addIssue(issue);
      for (const referencedPage of enrichment.referencedPages) {
        const canonical = directory.resolvePageId(referencedPage.id);
        if (canonical.kind !== "resolved" || canonical.page.namespace !== "0") {
          await addIssue(Object.freeze({
            kind: "unresolved-link", pageId: page.id, title: page.title,
            message: `could not materialize the semantic identity for referenced page ${referencedPage.title}: ${canonical.kind}`,
          }));
          continue;
        }
        const canonicalId = canonical.page.id;
        if (emittedEntityIds.has(canonicalId)) continue;
        emittedEntityIds.add(canonicalId);
        const kind = kindByPageId.get(canonicalId) ?? "entity";
        entitiesByKind.set(kind, (entitiesByKind.get(kind) ?? 0) + 1);
        for (const fact of identityFacts(canonical.page, kind, firstPass.sha256, kindEvidenceByPageId.get(canonicalId) ?? [])) await addFact(fact);
      }
      for (const fact of enrichment.facts) await addFact(fact);
    });
    if (secondPass.sha256 !== firstPass.sha256 || secondPass.pages !== firstPass.pages || secondPass.bytes !== firstPass.bytes) {
      throw new Error("XML source changed between identity-index and extraction passes");
    }

    await closeOutput(factsFile);
    await closeOutput(issuesOutput);
    const factDigest = factsHash.digest("hex");
    const issueSummary: IssueSummary = Object.freeze({
      counts: Object.freeze(Object.fromEntries([...issueCounts].sort(([left], [right]) => left.localeCompare(right)))),
      samples: Object.freeze(issueSamples),
    });
    const manifest = Object.freeze({
      formatVersion: 1,
      status: "complete",
      extractor: "onepiece-enrichment-v5",
      source: Object.freeze({ xmlSha256: firstPass.sha256, xmlBytes: firstPass.bytes, pageRecords: firstPass.pages }),
      directory: directoryAudit,
      classification: Object.freeze(classificationCounts),
      output: Object.freeze({ facts: factCount, bytes: factBytes, sha256: factDigest }),
      entitiesByKind: Object.freeze(Object.fromEntries([...entitiesByKind].sort(([left], [right]) => left.localeCompare(right)))),
      factsByField: Object.freeze(Object.fromEntries([...factsByField].sort(([left], [right]) => left.localeCompare(right)))),
      issues: issueSummary,
      policies: Object.freeze({
        semanticId: "kind-scoped UUIDv5 of the canonical MediaWiki page ID; titles are labels only",
        titleResolution: "first-letter/underscore normalization and explicit redirect chains; missing/ambiguous/cyclic targets are not guessed",
        templates: ["Char Box", "Crew Box", "Ship Box"],
        explicitRelations: ["affiliation", "occupation", "rank", "position", "ship", "crew", "captain"],
        membership: "explicit member/crew categories and ship-affiliation categories resolve to UID targets; former membership has a distinct predicate",
        duplicateClaims: "same page/evidence/predicate/target is emitted once and reported; distinct evidence sources remain separate facts",
        inference: "prose links and unlinked field text do not create relations",
        remoteWrites: false,
      }),
    });
    await writeFile(resolve(temporaryDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await rename(temporaryDirectory, finalDirectory);

    return Object.freeze({
      outputDirectory: finalDirectory,
      inputXmlSha256: firstPass.sha256,
      pages: firstPass.pages,
      facts: factCount,
      factsSha256: factDigest,
      entitiesByKind: manifest.entitiesByKind,
      factsByField: manifest.factsByField,
      issues: issueSummary.counts,
    });
  } catch (error) {
    factsOutput?.destroy();
    issuesOutput.destroy();
    throw new Error(`enrichment preparation failed; inspect retained partial output ${temporaryDirectory}`, { cause: error });
  }
}

function pageReference(page: WikiDumpPage) {
  return Object.freeze({
    id: page.id,
    title: page.title,
    namespace: page.namespace,
    ...(page.redirectTarget === undefined ? {} : { redirectTarget: page.redirectTarget }),
  });
}

function parseCorpusManifest(input: unknown): CorpusManifest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new TypeError("corpus manifest must be a JSON object");
  const row = input as Record<string, unknown>;
  if (typeof row["xmlSha256"] !== "string" || !/^[a-f0-9]{64}$/.test(row["xmlSha256"])) {
    throw new TypeError("corpus manifest must contain a lowercase XML SHA-256 digest");
  }
  if (typeof row["pages"] !== "number" || !Number.isSafeInteger(row["pages"]) || row["pages"] < 1) {
    throw new TypeError("corpus manifest must contain a positive page count");
  }
  return Object.freeze({ xmlSha256: row["xmlSha256"], pages: row["pages"] });
}

async function ensurePathAbsent(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`refusing to overwrite existing enrichment artifact: ${path}`);
}

async function writeJsonLine(output: WriteStream, input: unknown): Promise<void> {
  const line = `${JSON.stringify(input)}\n`;
  if (!output.write(line)) await once(output, "drain");
}

function countValues(values: Iterable<string>): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.freeze(Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right))));
}

async function closeOutput(output: WriteStream): Promise<void> {
  output.end();
  await once(output, "finish");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 2) throw new TypeError("usage: prepare-enrichment.ts [xml-path] [output-directory]");
  const result = await prepareOnePieceEnrichment(args[0] ?? DEFAULT_XML, DEFAULT_CORPUS_MANIFEST, args[1]);
  console.log(JSON.stringify(result, null, 2));
}
