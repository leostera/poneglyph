import type { FactInput } from "@leostera/poneglyph";
import { entityForTitle } from "./corpus.js";
import { onePieceEntityForPage, type OnePieceEntityKind } from "./onepiece-identities.js";
import type { WikiPageDirectory, WikiPageReference } from "./wiki-page-directory.js";
import type { WikiDumpPage } from "./wiki-xml.js";
import { scanCategoryLinks, scanTopLevelTemplates, scanTopLevelWikiLinks } from "./wikitext-templates.js";

export type PageClassification = Readonly<{
  kind: OnePieceEntityKind;
  evidence: readonly string[];
  issues: readonly ExtractionIssue[];
}>;
export type ExtractionIssue = Readonly<{
  kind: "wikitext-parse" | "unresolved-link" | "duplicate-claim" | "identity-conflict" | "unsupported-value";
  pageId: string;
  title: string;
  message: string;
  offset?: number;
}>;
export type PageEnrichment = Readonly<{
  facts: readonly FactInput[];
  referencedPages: readonly WikiPageReference[];
  issues: readonly ExtractionIssue[];
}>;

const SUPPORTED_TEMPLATES = ["Char Box", "Crew Box", "Ship Box"] as const;
const RELATION_FIELDS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  "char box": Object.freeze({
    affiliation: "onepiece:affiliation",
    occupation: "onepiece:occupation",
    rank: "onepiece:rank",
    position: "onepiece:position",
    ship: "onepiece:ship",
    crew: "onepiece:member_of",
  }),
  "crew box": Object.freeze({
    affiliation: "onepiece:affiliation",
    captain: "onepiece:captain",
    ship: "onepiece:ship",
  }),
  "ship box": Object.freeze({
    affiliation: "onepiece:affiliation",
    captain: "onepiece:captain",
    crew: "onepiece:crew",
  }),
});

export function classifyOnePiecePage(page: WikiDumpPage): PageClassification {
  if (page.namespace !== "0") return Object.freeze({ kind: "entity", evidence: [], issues: [] });

  const evidence: string[] = [];
  const candidates = new Set<OnePieceEntityKind>();
  const issues: ExtractionIssue[] = [];
  const templates = scanTopLevelTemplates(page.text, SUPPORTED_TEMPLATES);
  for (const template of templates.templates) {
    const normalized = template.name.trim().replaceAll("_", " ").toLocaleLowerCase("en-US");
    if (normalized === "char box") {
      candidates.add("character");
      evidence.push("template:Char Box");
    } else if (normalized === "crew box") {
      candidates.add("crew");
      evidence.push("template:Crew Box");
    } else if (normalized === "ship box") {
      candidates.add("ship");
      evidence.push("template:Ship Box");
    }
  }
  if (!templates.ok) issues.push(parseIssue(page, templates.error.offset, templates.error.message));

  const categories = scanCategoryLinks(page.text);
  for (const categoryName of categories.categories) {
    if (/(?:^|\s)characters?$/i.test(categoryName)) {
      candidates.add("character");
      evidence.push(`category:${categoryName}`);
    }
    if (/(?:^|\s)crews?$/i.test(categoryName)) {
      candidates.add("crew");
      evidence.push(`category:${categoryName}`);
    }
    if (/(?:^|\s)ships?$/i.test(categoryName)) {
      candidates.add("ship");
      evidence.push(`category:${categoryName}`);
    }
  }
  if (!categories.ok) issues.push(parseIssue(page, categories.error.offset, categories.error.message));

  if (candidates.size > 1) {
    issues.push(Object.freeze({
      kind: "identity-conflict",
      pageId: page.id,
      title: page.title,
      message: `conflicting explicit entity-kind evidence: ${[...candidates].sort().join(", ")}`,
    }));
    return Object.freeze({ kind: "entity", evidence: Object.freeze(evidence), issues: Object.freeze(issues) });
  }
  return Object.freeze({
    kind: candidates.values().next().value ?? "entity",
    evidence: Object.freeze(evidence),
    issues: Object.freeze(issues),
  });
}

export function identityFacts(
  page: WikiPageReference,
  kind: OnePieceEntityKind,
  corpusSha256: string,
  kindEvidence: readonly string[] = [],
): readonly FactInput[] {
  assertCorpusDigest(corpusSha256);
  const entity = onePieceEntityForPage(kind, page.id);
  const source = `wiki:onepiece:derived:${corpusSha256}:identity-v5:${page.id}`;
  return Object.freeze([
    makeFact(source, entity, "onepiece:name", { type: "text", value: page.title }),
    makeFact(source, entity, "onepiece:kind", { type: "reference", value: `onepiece:kind:${kind}` }),
    makeFact(source, entity, "onepiece:source_page", { type: "reference", value: entityForTitle(page.title) }),
    makeFact(source, entity, "onepiece:source_page_id", { type: "text", value: page.id }),
    ...kindEvidence.map(evidence => makeFact(source, entity, "onepiece:kind_evidence", { type: "text", value: evidence })),
  ]);
}

export function extractPageEnrichment(
  page: WikiDumpPage,
  directory: WikiPageDirectory,
  kindByPageId: ReadonlyMap<string, OnePieceEntityKind>,
  corpusSha256: string,
): PageEnrichment {
  assertCorpusDigest(corpusSha256);
  const issues: ExtractionIssue[] = [];
  const facts: FactInput[] = [];
  const referenced = new Map<string, WikiPageReference>();
  if (page.namespace !== "0") return Object.freeze({ facts: [], referencedPages: [], issues: [] });
  const self = directory.resolvePageId(page.id);
  if (self.kind !== "resolved" || self.page.id !== page.id) {
    if (page.redirectTarget !== undefined && self.kind === "resolved" && self.page.namespace === "0") {
      const kind = kindFor(self.page.id, kindByPageId);
      const entity = onePieceEntityForPage(kind, self.page.id);
      referenced.set(self.page.id, self.page);
      facts.push(makeFact(
        relationSource(corpusSha256, page.id, "redirect", "title"),
        entity,
        "onepiece:alias",
        { type: "text", value: page.title },
      ));
      return result();
    }
    if (self.kind !== "resolved") issues.push(Object.freeze({
      kind: "unresolved-link", pageId: page.id, title: page.title,
      message: `source page identity is ${self.kind}`,
    }));
    return result();
  }

  const subjectKind = kindFor(page.id, kindByPageId);
  const subject = onePieceEntityForPage(subjectKind, page.id);
  const templateScan = scanTopLevelTemplates(page.text, SUPPORTED_TEMPLATES);
  if (!templateScan.ok) issues.push(parseIssue(page, templateScan.error.offset, templateScan.error.message));
  const seenClaims = new Set<string>();

  for (const template of templateScan.templates) {
    const templateKey = template.name.trim().replaceAll("_", " ").toLocaleLowerCase("en-US");
    const fields = RELATION_FIELDS[templateKey];
    if (!fields) continue;
    for (const field of template.fields) {
      if (!field.name) continue;
      const predicate = fields[field.name];
      if (!predicate) continue;
      const linkScan = scanTopLevelWikiLinks(field.value);
      if (!linkScan.ok) issues.push(parseIssue(page, linkScan.error.offset, `field ${template.name}.${field.name}: ${linkScan.error.message}`));
      if (linkScan.links.length === 0 && field.value.length > 0) issues.push(Object.freeze({
        kind: "unsupported-value", pageId: page.id, title: page.title,
        message: `${template.name}.${field.name} has no explicit wiki-link target; omitted`,
      }));

      for (const targetTitle of linkScan.links) {
        const target = directory.resolveTitle(targetTitle);
        if (target.kind !== "resolved" || target.page.namespace !== "0") {
          issues.push(Object.freeze({
            kind: "unresolved-link", pageId: page.id, title: page.title,
            message: `${template.name}.${field.name} target ${JSON.stringify(targetTitle)} is ${target.kind === "resolved" ? `namespace ${target.page.namespace}` : target.kind}`,
          }));
          continue;
        }
        const targetKind = kindFor(target.page.id, kindByPageId);
        const targetEntity = onePieceEntityForPage(targetKind, target.page.id);
        const source = relationSource(corpusSha256, page.id, template.name, field.name);
        const claimKey = `${source}\u0000${predicate}\u0000${targetEntity}`;
        if (seenClaims.has(claimKey)) {
          issues.push(Object.freeze({
            kind: "duplicate-claim", pageId: page.id, title: page.title,
            message: `${template.name}.${field.name} repeats ${targetTitle}`,
          }));
          continue;
        }
        seenClaims.add(claimKey);
        referenced.set(target.page.id, target.page);
        facts.push(makeFact(
          source,
          subject,
          predicate,
          { type: "reference", value: targetEntity },
        ));
      }
    }
  }

  const categoryScan = scanCategoryLinks(page.text);
  if (!categoryScan.ok) issues.push(parseIssue(page, categoryScan.error.offset, categoryScan.error.message));
  for (const categoryName of categoryScan.categories) {
    const relation = categoryRelation(categoryName, subjectKind);
    if (!relation) continue;
    const target = directory.resolveTitle(relation.targetTitle);
    if (target.kind !== "resolved" || target.page.namespace !== "0") {
      if (relation.explicit) issues.push(Object.freeze({
        kind: "unresolved-link", pageId: page.id, title: page.title,
        message: `member category ${JSON.stringify(categoryName)} target is ${target.kind === "resolved" ? `namespace ${target.page.namespace}` : target.kind}`,
      }));
      continue;
    }
    const targetKind = kindFor(target.page.id, kindByPageId);
    if (relation.requiresCrew && targetKind !== "crew") {
      if (relation.explicit) issues.push(Object.freeze({
        kind: "unresolved-link", pageId: page.id, title: page.title,
        message: `category ${JSON.stringify(categoryName)} resolves to a page not classified as a crew`,
      }));
      continue;
    }
    if (target.page.id === page.id) continue;
    const targetEntity = onePieceEntityForPage(targetKind, target.page.id);
    const source = relationSource(corpusSha256, page.id, "category", categoryName);
    const claimKey = `${source}\u0000${relation.predicate}\u0000${targetEntity}`;
    if (seenClaims.has(claimKey)) continue;
    seenClaims.add(claimKey);
    referenced.set(target.page.id, target.page);
    facts.push(makeFact(
      source,
      subject,
      relation.predicate,
      { type: "reference", value: targetEntity },
    ));
  }

  if (facts.length > 0 || subjectKind !== "entity") referenced.set(page.id, page);
  return result();

  function result(): PageEnrichment {
    return Object.freeze({ facts: Object.freeze(facts), referencedPages: Object.freeze([...referenced.values()]), issues: Object.freeze(issues) });
  }
}

function categoryRelation(categoryName: string, subjectKind: OnePieceEntityKind): Readonly<{
  predicate: string;
  targetTitle: string;
  requiresCrew: boolean;
  explicit: boolean;
}> | undefined {
  const members = /^(.+?)\s+Members$/i.exec(categoryName);
  if (members?.[1]) return Object.freeze({
    predicate: subjectKind === "ship" ? "onepiece:affiliation" : "onepiece:member_of",
    targetTitle: members[1], requiresCrew: false, explicit: true,
  });

  const former = /^Former\s+(.+)$/i.exec(categoryName);
  if (former?.[1]) return Object.freeze({ predicate: "onepiece:former_member_of", targetTitle: former[1], requiresCrew: true, explicit: false });

  const possessiveShips = /^(.+?)['’](?:s)?\s+Ships$/i.exec(categoryName);
  const pluralShips = /^(.+?)\s+Ships$/i.exec(categoryName);
  const shipGroup = possessiveShips?.[1] ?? pluralShips?.[1];
  if (shipGroup) return subjectKind === "ship"
    ? Object.freeze({ predicate: "onepiece:affiliation", targetTitle: shipGroup, requiresCrew: true, explicit: true })
    : undefined;

  return Object.freeze({
    predicate: subjectKind === "ship" ? "onepiece:affiliation" : "onepiece:member_of",
    targetTitle: categoryName, requiresCrew: true, explicit: false,
  });
}

function kindFor(pageId: string, kinds: ReadonlyMap<string, OnePieceEntityKind>): OnePieceEntityKind {
  return kinds.get(pageId) ?? "entity";
}

function relationSource(corpusSha256: string, pageId: string, evidenceKind: string, field: string): string {
  return `wiki:onepiece:derived:${corpusSha256}:relations-v5:${pageId}:${encodeURIComponent(evidenceKind)}:${encodeURIComponent(field)}`;
}

function makeFact(source: string, entity: string, field: string, value: FactInput["value"]): FactInput {
  return Object.freeze({ source, entity, field, value, retraction: false });
}

function assertCorpusDigest(input: string): void {
  if (!/^[a-f0-9]{64}$/.test(input)) throw new TypeError("expected a lowercase SHA-256 corpus digest");
}

function parseIssue(page: WikiDumpPage, offset: number, message: string): ExtractionIssue {
  return Object.freeze({ kind: "wikitext-parse", pageId: page.id, title: page.title, offset, message });
}
