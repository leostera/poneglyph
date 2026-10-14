import {createHash} from "node:crypto";
import type {FactInput} from "@leostera/poneglyph";
import {normalizeValue, type Value} from "./model.js";
function canonicalValue(input: Value): Value {
  const value = normalizeValue(input);
  switch (value.type) {
    case "null": return {type: "null"};
    case "list": return {type: "list", value: value.value.map(canonicalValue)};
    case "map": return {type: "map", value: Object.fromEntries(Object.entries(value.value).map(([key, item]) => [key, canonicalValue(item)]))};
    case "boolean": return {type: "boolean", value: value.value};
    case "bytes": return {type: "bytes", value: value.value};
    default: return {type: value.type, value: value.value};
  }
}
// Independently construct the documented retained wire identity. No production
// parser, fact converter, serializer, planner or updater supplies expected data.
export function transactionDigest(txId: string, facts: readonly FactInput[]) {
  const payload = JSON.stringify({txId, facts: facts.map(fact => ({source: fact.source, entity: fact.entity, field: fact.field,
    value: canonicalValue(fact.value), retraction: fact.retraction ?? false}))});
  return createHash("sha256").update(payload).digest("hex");
}
