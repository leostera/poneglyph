import { parseFactId, parseStatedAt, parseTransactionId, parseUri, type FactId, type StatedAt, type TransactionId, type Uri } from "./identifiers.js";
import { parseFactValue, type FactValue } from "./fact-value.js";
import { isRecord, parsed, rejected, type ParseResult } from "./result.js";

export type FactDraft = Readonly<{
  source: Uri;
  entity: Uri;
  field: Uri;
  value: FactValue;
  retraction: boolean;
}>;

export type StoredFact = FactDraft & Readonly<{
  factId: FactId;
  statedAt: StatedAt;
  txId: TransactionId;
}>;

export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export type FactBatch = Readonly<{
  txId: TransactionId;
  facts: NonEmptyReadonlyArray<FactDraft>;
}>;

export function parseFactDraft(input: unknown, path = "fact"): ParseResult<FactDraft> {
  if (!isRecord(input)) return rejected(path, "expected a fact object");

  const source = parseUri(input["source"], `${path}.source`);
  if (!source.ok) return source;
  const entity = parseUri(input["entity"], `${path}.entity`);
  if (!entity.ok) return entity;
  const field = parseUri(input["field"], `${path}.field`);
  if (!field.ok) return field;
  const value = parseFactValue(input["value"], `${path}.value`);
  if (!value.ok) return value;
  if (typeof input["retraction"] !== "boolean") {
    return rejected(`${path}.retraction`, "expected a boolean");
  }

  return parsed(Object.freeze({
    source: source.value,
    entity: entity.value,
    field: field.value,
    value: value.value,
    retraction: input["retraction"],
  }));
}

export function parseStoredFact(input: unknown, path = "fact"): ParseResult<StoredFact> {
  if (!isRecord(input)) return rejected(path, "expected a stored fact object");

  const draft = parseFactDraft(input, path);
  if (!draft.ok) return draft;
  const factId = parseFactId(input["factId"], `${path}.factId`);
  if (!factId.ok) return factId;
  const statedAt = parseStatedAt(input["statedAt"], `${path}.statedAt`);
  if (!statedAt.ok) return statedAt;
  const txId = parseTransactionId(input["txId"], `${path}.txId`);
  if (!txId.ok) return txId;

  return parsed(Object.freeze({
    ...draft.value,
    factId: factId.value,
    statedAt: statedAt.value,
    txId: txId.value,
  }));
}

export function parseFactBatch(input: unknown, path = "batch"): ParseResult<FactBatch> {
  if (!isRecord(input)) return rejected(path, "expected a fact batch object");
  const txId = parseTransactionId(input["txId"], `${path}.txId`);
  if (!txId.ok) return txId;
  if (!Array.isArray(input["facts"]) || input["facts"].length === 0) {
    return rejected(`${path}.facts`, "expected a non-empty array of facts");
  }

  const facts: FactDraft[] = [];
  for (const [index, inputFact] of input["facts"].entries()) {
    const fact = parseFactDraft(inputFact, `${path}.facts[${index}]`);
    if (!fact.ok) return fact;
    facts.push(fact.value);
  }

  return parsed(Object.freeze({
    txId: txId.value,
    facts: Object.freeze(facts) as NonEmptyReadonlyArray<FactDraft>,
  }));
}
