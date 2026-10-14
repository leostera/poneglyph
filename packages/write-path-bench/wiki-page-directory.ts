import type { WikiPageId } from "./onepiece-identities.js";

export type WikiPageReference = Readonly<{
  id: WikiPageId;
  title: string;
  namespace: string;
  redirectTarget?: string;
}>;
export type TitleResolution =
  | Readonly<{ kind: "resolved"; page: WikiPageReference }>
  | Readonly<{ kind: "missing"; title: string }>
  | Readonly<{ kind: "ambiguous"; title: string; pageIds: readonly WikiPageId[] }>
  | Readonly<{ kind: "redirect-cycle"; title: string; pageIds: readonly WikiPageId[] }>;
export type WikiPageDirectoryAudit = Readonly<{
  pageRecords: number;
  duplicateTitleGroups: number;
  duplicatePageIdGroups: number;
  duplicateTitleSamples: readonly Readonly<{ title: string; pageIds: readonly WikiPageId[] }>[];
  duplicatePageIdSamples: readonly Readonly<{ pageId: WikiPageId; titles: readonly string[] }>[];
}>;

/** A source-title resolver. Semantic facts use the resolved page ID, never this title. */
export class WikiPageDirectory {
  #byTitle = new Map<string, WikiPageReference[]>();
  #byId = new Map<WikiPageId, WikiPageReference[]>();

  add(page: WikiPageReference): void {
    const titleKey = normalizeMediaWikiTitle(page.title);
    const titlePages = this.#byTitle.get(titleKey) ?? [];
    titlePages.push(Object.freeze({ ...page }));
    this.#byTitle.set(titleKey, titlePages);

    const idPages = this.#byId.get(page.id) ?? [];
    idPages.push(Object.freeze({ ...page }));
    this.#byId.set(page.id, idPages);
  }

  resolveTitle(input: string): TitleResolution {
    const requestedTitle = normalizeLinkTitle(input);
    let current = this.#lookup(requestedTitle);
    if (current.kind !== "resolved") return current;

    const seen = new Set<WikiPageId>();
    const chain: WikiPageId[] = [];
    while (current.kind === "resolved") {
      if (seen.has(current.page.id)) {
        return Object.freeze({ kind: "redirect-cycle", title: requestedTitle, pageIds: Object.freeze([...chain, current.page.id]) });
      }
      seen.add(current.page.id);
      chain.push(current.page.id);
      if (current.page.redirectTarget === undefined) return current;
      current = this.#lookup(normalizeLinkTitle(current.page.redirectTarget));
    }
    return current;
  }

  audit(): WikiPageDirectoryAudit {
    const duplicateTitleSamples: Array<{ title: string; pageIds: readonly WikiPageId[] }> = [];
    const duplicatePageIdSamples: Array<{ pageId: WikiPageId; titles: readonly string[] }> = [];
    let duplicateTitleGroups = 0;
    let duplicatePageIdGroups = 0;
    for (const pages of this.#byTitle.values()) {
      if (pages.length < 2) continue;
      duplicateTitleGroups++;
      if (duplicateTitleSamples.length < 100) duplicateTitleSamples.push({
        title: pages[0]!.title, pageIds: Object.freeze(pages.map(page => page.id)),
      });
    }
    for (const [pageId, pages] of this.#byId) {
      if (pages.length < 2) continue;
      duplicatePageIdGroups++;
      if (duplicatePageIdSamples.length < 100) duplicatePageIdSamples.push({
        pageId, titles: Object.freeze(pages.map(page => page.title)),
      });
    }
    return Object.freeze({
      pageRecords: [...this.#byId.values()].reduce((sum, pages) => sum + pages.length, 0),
      duplicateTitleGroups,
      duplicatePageIdGroups,
      duplicateTitleSamples: Object.freeze(duplicateTitleSamples),
      duplicatePageIdSamples: Object.freeze(duplicatePageIdSamples),
    });
  }

  resolvePageId(input: WikiPageId): TitleResolution {
    const pages = this.#byId.get(input) ?? [];
    if (pages.length === 0) return Object.freeze({ kind: "missing", title: input });
    if (pages.length !== 1) {
      return Object.freeze({ kind: "ambiguous", title: pages[0]!.title, pageIds: Object.freeze(pages.map(page => page.id)) });
    }
    const page = pages[0]!;
    return page.redirectTarget === undefined ? Object.freeze({ kind: "resolved", page }) : this.resolveTitle(page.redirectTarget);
  }

  #lookup(title: string): TitleResolution {
    const pages = this.#byTitle.get(normalizeMediaWikiTitle(title)) ?? [];
    const distinctIds = [...new Set(pages.map(page => page.id))];
    if (distinctIds.length === 0) return Object.freeze({ kind: "missing", title });
    if (distinctIds.length > 1 || pages.length > 1) {
      return Object.freeze({ kind: "ambiguous", title, pageIds: Object.freeze(distinctIds) });
    }
    return Object.freeze({ kind: "resolved", page: pages[0]! });
  }
}

function normalizeLinkTitle(title: string): string {
  return title.trim().replace(/^:/, "").split("#", 1)[0]!.replaceAll("_", " ").replace(/\s+/g, " ");
}

function normalizeMediaWikiTitle(title: string): string {
  const normalized = title.replaceAll("_", " ").replace(/\s+/g, " ").trim();
  const first = [...normalized][0];
  return first === undefined ? normalized : first.toUpperCase() + normalized.slice(first.length);
}
