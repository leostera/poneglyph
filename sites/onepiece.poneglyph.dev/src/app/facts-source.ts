// Facts are authored as a TypeScript module whose default export is an array
// literal. The browser never evaluates it (the CSP forbids eval): the array is
// extracted and parsed as JSON5, then shaped into FactDraft values. The server
// remains the authority on URIs, value encodings and limits.
import JSON5 from "json5";
import type { FactDraft } from "./api.ts";

export const KNOWN_FIELDS = [
  "onepiece:name", "onepiece:alias", "onepiece:kind", "onepiece:member_of", "onepiece:former_member_of", "onepiece:captain",
  "onepiece:affiliation", "onepiece:occupation", "onepiece:ship", "onepiece:bounty", "onepiece:source_page",
  "wiki:page:title", "wiki:page:category", "wiki:page:link", "wiki:page:namespace", "wiki:page:text_bytes",
] as const;

/** Ambient types for the editor; mirrors the /api/facts contract. */
export const FACT_TYPES = `
type Uri = string;
type KnownField = ${KNOWN_FIELDS.map(field => JSON.stringify(field)).join(" | ")};
type FactValue =
  | { type: "text"; value: string }
  /** Signed 64-bit integer. Use a string above Number.MAX_SAFE_INTEGER. */
  | { type: "number"; value: number | \`\${bigint}\` }
  | { type: "boolean"; value: boolean }
  /** Another entity's URI, e.g. "onepiece:crew:…". */
  | { type: "reference"; value: Uri }
  /** YYYY-MM-DD */
  | { type: "date"; value: string }
  /** RFC 3339, e.g. "2026-10-21T12:00:00Z" */
  | { type: "date_time"; value: string };
/** One fact. The playground sets the source for you. */
interface Fact {
  /** Entity URI. New entities: pick any URI, e.g. "playground:pirate:<something>". */
  entity: Uri;
  /** Field URI. Any URI works; common fields autocomplete. */
  field: KnownField | (Uri & {});
  value: FactValue;
  /** true undoes an earlier fact with the same entity, field and value. */
  retract?: boolean;
}
`;

export function starterSource(author: string): string {
  const entity = `playground:pirate:${author}-${Math.random().toString(36).slice(2, 7)}`;
  return `// All of these are saved together, or none are.
// Hover any field for help. ⌘↵ saves.
export default [
  { entity: "${entity}", field: "onepiece:name", value: { type: "text", value: "Captain Demo" } },
  { entity: "${entity}", field: "onepiece:bounty", value: { type: "number", value: 1500000000 } },
  {
    entity: "${entity}",
    field: "onepiece:member_of",
    // Straw Hat Pirates
    value: { type: "reference", value: "onepiece:crew:7802a7e4-aeb6-58c5-8999-f08deccc5902" },
  },
] satisfies Fact[];
`;
}

export type ParsedFacts = { ok: true; facts: FactDraft[] } | { ok: false; error: string };

/** Relation suggestions are observational: only fields with reference values in this snapshot. */
export function observedRelationFields(fields: readonly { field: string; valueTags: readonly string[] }[]): string[] {
  return [...new Set(fields.filter(field => field.valueTags.includes("reference")).map(field => field.field))].sort();
}

/** Extract the current field literal prefix before the Monaco cursor, if editing one. */
export function fieldLiteralPrefix(line: string): string | undefined {
  return /\bfield\s*:\s*(["'])([^"'\\]*)$/.exec(line)?.[2];
}

const VALUE_TYPES = new Set(["text", "number", "boolean", "reference", "date", "date_time"]);

export function parseFactsSource(source: string, limit: number): ParsedFacts {
  const start = source.search(/export\s+default\s*\[/);
  if (start < 0) return { ok: false, error: "Expected `export default [ … ]`." };
  const open = source.indexOf("[", start);
  const end = arrayEnd(source, open);
  if (end < 0) return { ok: false, error: "Unclosed array literal." };
  const rest = source.slice(end + 1).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").trim();
  if (!/^(satisfies\s+Fact\[\]\s*)?;?$/.test(rest)) return { ok: false, error: "Only `satisfies Fact[]` may follow the array." };
  let value: unknown;
  try { value = JSON5.parse(source.slice(open, end + 1)); }
  catch (error) { return { ok: false, error: `Use plain values only; variables and expressions aren't supported (${error instanceof Error ? error.message : String(error)}).` }; }
  if (!Array.isArray(value) || value.length === 0) return { ok: false, error: "Write at least one fact." };
  if (value.length > limit) return { ok: false, error: `At most ${limit} facts at a time (got ${value.length}).` };
  const facts: FactDraft[] = [];
  for (const [index, candidate] of value.entries()) {
    const fact = shape(candidate);
    if (typeof fact === "string") return { ok: false, error: `Fact ${index + 1}: ${fact}` };
    facts.push(fact);
  }
  return { ok: true, facts };
}

function shape(candidate: unknown): FactDraft | string {
  if (!isRecord(candidate)) return "expected an object";
  const extra = Object.keys(candidate).filter(key => !["entity", "field", "value", "retract"].includes(key));
  if (extra.length > 0) return `unknown key ${extra.map(key => `"${key}"`).join(", ")}`;
  const { entity, field, value, retract } = candidate;
  if (typeof entity !== "string" || entity === "") return "entity must be a URI string";
  if (typeof field !== "string" || field === "") return "field must be a URI string";
  if (retract !== undefined && typeof retract !== "boolean") return "retract must be true or false";
  if (!isRecord(value) || typeof value.type !== "string" || !VALUE_TYPES.has(value.type)) return `value.type must be one of ${[...VALUE_TYPES].join(", ")}`;
  const raw = value.value;
  if (value.type === "boolean") {
    if (typeof raw !== "boolean") return "boolean values are true or false";
    return { entity, field, value: { type: "boolean", value: raw }, retraction: retract ?? false };
  }
  if (value.type === "number") {
    if (typeof raw === "number" && !Number.isSafeInteger(raw)) return "numbers must be integers; quote values beyond ±2^53";
    if (typeof raw !== "number" && !(typeof raw === "string" && /^-?\d+$/.test(raw))) return "number values are integers";
    return { entity, field, value: { type: "number", value: String(raw) }, retraction: retract ?? false };
  }
  if (typeof raw !== "string") return `${value.type} values are strings`;
  return { entity, field, value: { type: value.type, value: raw }, retraction: retract ?? false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Index of the "]" closing the array opened at `open`, skipping strings and comments. */
function arrayEnd(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const character = source[index];
    if (character === '"' || character === "'" || character === "`") {
      for (index++; index < source.length && source[index] !== character; index++) if (source[index] === "\\") index++;
    } else if (character === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index++;
    } else if (character === "/" && source[index + 1] === "*") {
      index = source.indexOf("*/", index + 2); if (index < 0) return -1; index++;
    } else if (character === "[" || character === "{") depth++;
    else if (character === "]" || character === "}") { depth--; if (depth === 0) return character === "]" ? index : -1; }
  }
  return -1;
}
