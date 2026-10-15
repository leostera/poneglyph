import type {FactValue} from "../domain/fact-value.js";
import {parseFactValue} from "../domain/fact-value.js";
import type {DatalogValue} from "../datalog/value.js";
import {factScalarToDatalogValue, sameDatalogValue} from "../datalog/value.js";
import {isRecord} from "../domain/result.js";

// active_values.value_key indexes the canonical FactValue JSON, not its exposed
// Datalog value. Enumerate every original FactValue whose conversion is exactly
// this Datalog value so the index narrows reads without changing many-to-one
// conversion semantics.
export function valueIndexKeysForDatalogValue(value: DatalogValue): readonly string[] {
  const candidates: unknown[] = [];
  if (value.type === "integer") {
    candidates.push({type: "number", value: value.value});
  } else {
    candidates.push({type: "text", value: value.value});
    candidates.push({type: "reference", value: value.value});
    candidates.push({type: "date", value: value.value});
    candidates.push({type: "date_time", value: value.value});
    if (value.value === "true" || value.value === "false") candidates.push({type: "boolean", value: value.value === "true"});
    if (value.value === "null") candidates.push({type: "null"});

    const decoded = parseJson(value.value);
    if (Array.isArray(decoded)) {
      candidates.push({type: "bytes", value: decoded});
      candidates.push({type: "list", value: decoded});
    } else if (isRecord(decoded)) {
      candidates.push({type: "map", value: decoded});
    }
  }

  const keys = new Set<string>();
  for (const candidate of candidates) {
    const parsed = parseFactValue(candidate);
    if (!parsed.ok || !sameDatalogValue(factScalarToDatalogValue(parsed.value), value)) continue;
    keys.add(JSON.stringify(parsed.value));
  }
  if (keys.size === 0) throw new Error("Datalog value has no canonical FactValue index key");
  return Object.freeze([...keys].sort());
}

function parseJson(input: string): unknown {
  try { return JSON.parse(input) as unknown; }
  catch { return undefined; }
}
