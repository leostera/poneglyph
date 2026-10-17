import type { FactValue } from "./fact-value.js";
import { isRecord, rejected, type ParseResult } from "./result.js";
import { parseUri } from "./identifiers.js";

export type ObservedValueTag = FactValue["type"];
export type SchemaSnapshotOwner = Readonly<{
  prefix: string;
  sequence: number;
  epoch: number;
}>;
export type ObservedField = Readonly<{
  field: string;
  valueTags: readonly ObservedValueTag[];
}>;
export type GraphSchemaObservation = Readonly<{
  snapshotSeq: number;
  sequenceScope: "subtree-vector";
  snapshotVector: readonly SchemaSnapshotOwner[];
  fields: readonly ObservedField[];
}>;

const VALUE_TAGS: ReadonlySet<string> = new Set([
  "null", "text", "number", "boolean", "bytes", "reference", "date", "date_time", "list", "map",
]);

export function parseGraphSchemaObservation(input: unknown): ParseResult<GraphSchemaObservation> {
  if (!isRecord(input)) return rejected("schema", "expected an observed graph schema object");
  if (!isNonNegativeSafeInteger(input["snapshotSeq"]) || input["sequenceScope"] !== "subtree-vector") {
    return rejected("schema.snapshot", "expected a non-negative snapshot sequence and subtree-vector scope");
  }
  const rawVector = input["snapshotVector"];
  if (!Array.isArray(rawVector) || rawVector.length === 0 || rawVector.length > 256) {
    return rejected("schema.snapshotVector", "expected a non-empty bounded owner snapshot vector");
  }
  const snapshotVector: SchemaSnapshotOwner[] = [];
  const seenOwners = new Set<string>();
  for (const [index, rawOwner] of rawVector.entries()) {
    if (!isRecord(rawOwner) || typeof rawOwner["prefix"] !== "string" || rawOwner["prefix"].length > 256 ||
        !isNonNegativeSafeInteger(rawOwner["sequence"]) || !isNonNegativeSafeInteger(rawOwner["epoch"])) {
      return rejected(`schema.snapshotVector[${index}]`, "expected a valid owner prefix, sequence, and epoch");
    }
    if (seenOwners.has(rawOwner["prefix"])) return rejected(`schema.snapshotVector[${index}].prefix`, "duplicate snapshot owner");
    seenOwners.add(rawOwner["prefix"]);
    snapshotVector.push(Object.freeze({prefix: rawOwner["prefix"], sequence: rawOwner["sequence"], epoch: rawOwner["epoch"]}));
  }
  const maximumSequence = Math.max(...snapshotVector.map(owner => owner.sequence));
  if (input["snapshotSeq"] !== maximumSequence) return rejected("schema.snapshotSeq", "does not summarize the declared snapshot vector");

  const rawFields = input["fields"];
  if (!Array.isArray(rawFields) || rawFields.length > 2_000) return rejected("schema.fields", "expected a bounded observed field list");
  const fields: ObservedField[] = [];
  const seenFields = new Set<string>();
  for (const [index, rawField] of rawFields.entries()) {
    if (!isRecord(rawField)) return rejected(`schema.fields[${index}]`, "expected an observed field object");
    const field = parseUri(rawField["field"], `schema.fields[${index}].field`);
    if (!field.ok || field.value !== rawField["field"]) return rejected(`schema.fields[${index}].field`, "expected a canonical field URI");
    if (seenFields.has(field.value)) return rejected(`schema.fields[${index}].field`, "duplicate observed field");
    seenFields.add(field.value);
    const rawTags = rawField["valueTags"];
    if (!Array.isArray(rawTags) || rawTags.length === 0) return rejected(`schema.fields[${index}].valueTags`, "expected at least one observed value tag");
    const tags: ObservedValueTag[] = [];
    const seenTags = new Set<string>();
    for (const [tagIndex, rawTag] of rawTags.entries()) {
      if (typeof rawTag !== "string" || !VALUE_TAGS.has(rawTag) || seenTags.has(rawTag)) {
        return rejected(`schema.fields[${index}].valueTags[${tagIndex}]`, "unknown or duplicate FactValue tag");
      }
      seenTags.add(rawTag);
      tags.push(rawTag as ObservedValueTag);
    }
    fields.push(Object.freeze({field: field.value, valueTags: Object.freeze(tags)}));
  }
  return {
    ok: true,
    value: Object.freeze({
      snapshotSeq: input["snapshotSeq"],
      sequenceScope: "subtree-vector",
      snapshotVector: Object.freeze(snapshotVector),
      fields: Object.freeze(fields),
    }),
  };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
