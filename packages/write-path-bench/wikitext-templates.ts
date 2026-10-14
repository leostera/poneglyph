export type TemplateField = Readonly<{ name: string | undefined; value: string }>;
export type WikitextTemplate = Readonly<{ name: string; fields: readonly TemplateField[] }>;
export type TemplateScanResult =
  | Readonly<{ ok: true; templates: readonly WikitextTemplate[] }>
  | Readonly<{ ok: false; templates: readonly WikitextTemplate[]; error: Readonly<{ offset: number; message: string }> }>;
export type WikiLinkScanResult =
  | Readonly<{ ok: true; links: readonly string[] }>
  | Readonly<{ ok: false; links: readonly string[]; error: Readonly<{ offset: number; message: string }> }>;
export type CategoryScanResult =
  | Readonly<{ ok: true; categories: readonly string[] }>
  | Readonly<{ ok: false; categories: readonly string[]; error: Readonly<{ offset: number; message: string }> }>;

/** Find requested top-level templates without expanding nested templates. */
export function scanTopLevelTemplates(text: string, requestedNames: readonly string[]): TemplateScanResult {
  const requested = new Set(requestedNames.map(normalizeTemplateName));
  const templates: WikitextTemplate[] = [];

  for (let offset = 0; offset < text.length;) {
    const literalEnd = skipCommentOrLiteralTag(text, offset);
    if (literalEnd.kind === "error") return failedTemplateScan(templates, offset, literalEnd.message);
    if (literalEnd.kind === "skipped") {
      offset = literalEnd.end;
      continue;
    }

    if (text.startsWith("{{{", offset)) {
      const end = findBalanced(text, offset, 3);
      if (!end.ok) return failedTemplateScan(templates, end.error.offset, end.error.message);
      offset = end.end;
      continue;
    }
    if (!text.startsWith("{{", offset)) {
      offset++;
      continue;
    }

    const end = findBalanced(text, offset, 2);
    if (!end.ok) return failedTemplateScan(templates, end.error.offset, end.error.message);
    const body = text.slice(offset + 2, end.end - 2);
    const argumentParts = splitTopLevel(body, "|");
    if (!argumentParts.ok) return failedTemplateScan(templates, offset + 2 + argumentParts.offset, argumentParts.message);

    const rawName = argumentParts.parts[0]?.trim() ?? "";
    if (requested.has(normalizeTemplateName(rawName))) {
      const fields: TemplateField[] = [];
      for (const argument of argumentParts.parts.slice(1)) {
        const equals = findTopLevelCharacter(argument, "=");
        if (!equals.ok) return failedTemplateScan(templates, offset + 2 + equals.offset, equals.message);
        if (equals.index === undefined) {
          fields.push(Object.freeze({ name: undefined, value: argument.trim() }));
        } else {
          const name = argument.slice(0, equals.index).trim().toLowerCase();
          fields.push(Object.freeze({ name: name || undefined, value: argument.slice(equals.index + 1).trim() }));
        }
      }
      templates.push(Object.freeze({ name: rawName, fields: Object.freeze(fields) }));
    }
    offset = end.end;
  }

  return { ok: true, templates: Object.freeze(templates) };
}

/** Extract direct wiki-link targets, ignoring links nested inside templates/comments. */
export function extractTopLevelWikiLinks(
  value: string,
  options: Readonly<{ includeNonEntityNamespaces?: boolean }> = {},
): readonly string[] {
  return scanTopLevelWikiLinks(value, options).links;
}

export function scanCategoryLinks(text: string): CategoryScanResult {
  const categories: string[] = [];
  for (let offset = 0; offset < text.length;) {
    const literalEnd = skipCommentOrLiteralTag(text, offset);
    if (literalEnd.kind === "skipped") {
      offset = literalEnd.end;
      continue;
    }
    if (literalEnd.kind === "error") return failedCategoryScan(categories, offset, literalEnd.message);
    if (!text.startsWith("[[", offset)) {
      offset++;
      continue;
    }

    const link = findBalancedLink(text, offset);
    if (!link.ok) return failedCategoryScan(categories, link.error.offset, link.error.message);
    const body = text.slice(offset + 2, link.end - 2);
    const target = body.split("|")[0]?.split("#")[0]?.replaceAll("_", " ").trim();
    if (target && /^category:/i.test(target)) {
      const name = target.slice(target.indexOf(":") + 1).trim();
      if (name) categories.push(name);
    }
    offset = link.end;
  }
  return Object.freeze({ ok: true, categories: Object.freeze(categories) });
}

export function scanTopLevelWikiLinks(
  value: string,
  options: Readonly<{ includeNonEntityNamespaces?: boolean }> = {},
): WikiLinkScanResult {
  const targets: string[] = [];
  for (let offset = 0; offset < value.length;) {
    const literalEnd = skipCommentOrLiteralTag(value, offset);
    if (literalEnd.kind === "skipped") {
      offset = literalEnd.end;
      continue;
    }
    if (literalEnd.kind === "error") return failedWikiLinkScan(targets, offset, literalEnd.message);

    if (value.startsWith("{{{", offset)) {
      const end = findBalanced(value, offset, 3);
      if (!end.ok) return failedWikiLinkScan(targets, end.error.offset, end.error.message);
      offset = end.end;
      continue;
    }
    if (value.startsWith("{{", offset)) {
      const end = findBalanced(value, offset, 2);
      if (!end.ok) return failedWikiLinkScan(targets, end.error.offset, end.error.message);
      offset = end.end;
      continue;
    }
    if (!value.startsWith("[[", offset)) {
      offset++;
      continue;
    }

    const link = findBalancedLink(value, offset);
    if (!link.ok) return failedWikiLinkScan(targets, link.error.offset, link.error.message);
    const body = value.slice(offset + 2, link.end - 2);
    const target = body.split("|")[0]?.split("#")[0]?.replaceAll("_", " ").trim();
    if (target && (options.includeNonEntityNamespaces === true || !isNonEntityNamespace(target))) targets.push(target);
    offset = link.end;
  }
  return Object.freeze({ ok: true, links: Object.freeze(targets) });
}

function failedCategoryScan(categories: readonly string[], offset: number, message: string): CategoryScanResult {
  return Object.freeze({ ok: false, categories: Object.freeze([...categories]), error: Object.freeze({ offset, message }) });
}

function failedWikiLinkScan(links: readonly string[], offset: number, message: string): WikiLinkScanResult {
  return Object.freeze({ ok: false, links: Object.freeze([...links]), error: Object.freeze({ offset, message }) });
}

function failedTemplateScan(
  templates: readonly WikitextTemplate[],
  offset: number,
  message: string,
): TemplateScanResult {
  return Object.freeze({ ok: false, templates: Object.freeze([...templates]), error: Object.freeze({ offset, message }) });
}

function normalizeTemplateName(name: string): string {
  return name.trim().replaceAll("_", " ").replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

type BalancedResult =
  | Readonly<{ ok: true; end: number }>
  | Readonly<{ ok: false; error: Readonly<{ offset: number; message: string }> }>;

function findBalanced(text: string, start: number, openingLength: 2 | 3): BalancedResult {
  let depth = 1;
  for (let offset = start + openingLength; offset < text.length;) {
    const literalEnd = skipCommentOrLiteralTag(text, offset);
    if (literalEnd.kind === "error") return { ok: false, error: { offset, message: literalEnd.message } };
    if (literalEnd.kind === "skipped") {
      offset = literalEnd.end;
      continue;
    }

    if (text.startsWith("{{{", offset)) {
      depth++;
      offset += 3;
    } else if (text.startsWith("{{", offset)) {
      depth++;
      offset += 2;
    } else if (text.startsWith("}}}", offset)) {
      depth--;
      offset += 3;
      if (depth === 0) return { ok: true, end: offset };
    } else if (text.startsWith("}}", offset)) {
      depth--;
      offset += 2;
      if (depth === 0) return { ok: true, end: offset };
    } else {
      offset++;
    }
  }
  return { ok: false, error: { offset: start, message: "unclosed template or parameter" } };
}

function findBalancedLink(text: string, start: number): BalancedResult {
  let depth = 1;
  for (let offset = start + 2; offset < text.length;) {
    const literalEnd = skipCommentOrLiteralTag(text, offset);
    if (literalEnd.kind === "skipped") {
      offset = literalEnd.end;
      continue;
    }
    if (text.startsWith("[[", offset)) {
      depth++;
      offset += 2;
    } else if (text.startsWith("]]", offset)) {
      depth--;
      offset += 2;
      if (depth === 0) return { ok: true, end: offset };
    } else {
      offset++;
    }
  }
  return { ok: false, error: { offset: start, message: "unclosed wiki link" } };
}

type SplitResult =
  | Readonly<{ ok: true; parts: readonly string[] }>
  | Readonly<{ ok: false; offset: number; message: string }>;

function splitTopLevel(text: string, separator: string): SplitResult {
  const parts: string[] = [];
  let start = 0;
  let templateDepth = 0;
  let linkDepth = 0;
  for (let offset = 0; offset < text.length;) {
    const literalEnd = skipCommentOrLiteralTag(text, offset);
    if (literalEnd.kind === "error") return { ok: false, offset, message: literalEnd.message };
    if (literalEnd.kind === "skipped") {
      offset = literalEnd.end;
      continue;
    }

    if (text.startsWith("{{{", offset) || text.startsWith("{{", offset)) {
      templateDepth++;
      offset += text.startsWith("{{{", offset) ? 3 : 2;
    } else if ((text.startsWith("}}}", offset) || text.startsWith("}}", offset)) && templateDepth > 0) {
      templateDepth--;
      offset += text.startsWith("}}}", offset) ? 3 : 2;
    } else if (text.startsWith("[[", offset)) {
      linkDepth++;
      offset += 2;
    } else if (text.startsWith("]]", offset) && linkDepth > 0) {
      linkDepth--;
      offset += 2;
    } else if (text.startsWith(separator, offset) && templateDepth === 0 && linkDepth === 0) {
      parts.push(text.slice(start, offset));
      offset += separator.length;
      start = offset;
    } else {
      offset++;
    }
  }
  if (templateDepth !== 0) return { ok: false, offset: text.length, message: "unclosed nested template" };
  if (linkDepth !== 0) return { ok: false, offset: text.length, message: "unclosed nested wiki link" };
  parts.push(text.slice(start));
  return { ok: true, parts: Object.freeze(parts) };
}

type CharacterResult =
  | Readonly<{ ok: true; index: number | undefined }>
  | Readonly<{ ok: false; offset: number; message: string }>;

function findTopLevelCharacter(text: string, character: string): CharacterResult {
  const parts = splitTopLevel(text, character);
  if (!parts.ok) return parts;
  return { ok: true, index: parts.parts.length > 1 ? parts.parts[0]!.length : undefined };
}

type LiteralSkipResult =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "skipped"; end: number }>
  | Readonly<{ kind: "error"; message: string }>;

const literalTagNames = ["nowiki", "pre", "syntaxhighlight", "source", "math"] as const;
function skipCommentOrLiteralTag(text: string, offset: number): LiteralSkipResult {
  if (text.startsWith("<!--", offset)) {
    const end = text.indexOf("-->", offset + 4);
    return end < 0 ? { kind: "error", message: "unclosed comment" } : { kind: "skipped", end: end + 3 };
  }

  for (const tagName of literalTagNames) {
    const openTag = new RegExp(`^<${tagName}\\b[^>]*>`, "i").exec(text.slice(offset));
    if (!openTag) continue;
    if (/\/\s*>$/.test(openTag[0])) return { kind: "skipped", end: offset + openTag[0].length };
    const closeTag = new RegExp(`</${tagName}\\s*>`, "ig");
    closeTag.lastIndex = offset + openTag[0].length;
    const closing = closeTag.exec(text);
    return closing === null
      ? { kind: "error", message: `unclosed <${tagName}> block` }
      : { kind: "skipped", end: closeTag.lastIndex };
  }
  return { kind: "none" };
}

const nonEntityNamespaces = new Set(["category", "file", "image", "template", "special", "user", "talk", "help", "media"]);
function isNonEntityNamespace(target: string): boolean {
  const colon = target.indexOf(":");
  return colon > 0 && nonEntityNamespaces.has(target.slice(0, colon).toLocaleLowerCase("en-US"));
}
