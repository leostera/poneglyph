import type { FactValue } from "../domain/fact-value.js";

export type DatalogValue =
  | Readonly<{ type: "string"; value: string }>
  | Readonly<{ type: "integer"; value: string }>;

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

export function stringValue(value: string): DatalogValue {
  return Object.freeze({ type: "string", value });
}

export function integerValue(value: bigint): DatalogValue {
  return Object.freeze({ type: "integer", value: value.toString() });
}

export function factValueToDatalogValues(value: FactValue): readonly DatalogValue[] {
  if (value.type === "list") {
    return Object.freeze(value.value.map(factScalarToDatalogValue));
  }
  return Object.freeze([factScalarToDatalogValue(value)]);
}

export function factScalarToDatalogValue(value: FactValue): DatalogValue {
  switch (value.type) {
    case "null":
      return stringValue("null");
    case "text":
      return stringValue(value.value);
    case "number":
      return numberOrString(value.value);
    case "boolean":
      return stringValue(String(value.value));
    case "bytes":
      return stringValue(JSON.stringify(value.value));
    case "reference":
    case "date":
    case "date_time":
      return stringValue(value.value);
    case "list":
      return stringValue(JSON.stringify(value.value.map(toSerdeValue)));
    case "map":
      return stringValue(JSON.stringify(
        Object.fromEntries(Object.entries(value.value).map(([key, item]) => [key, toSerdeValue(item)])),
      ));
  }
}

export function sameDatalogValue(left: DatalogValue, right: DatalogValue): boolean {
  return left.type === right.type && left.value === right.value;
}

export function compareDatalogValues(left: DatalogValue, right: DatalogValue): number | undefined {
  if (left.type !== right.type) return undefined;
  if (left.type === "integer" && right.type === "integer") {
    const leftInteger = BigInt(left.value);
    const rightInteger = BigInt(right.value);
    return leftInteger < rightInteger ? -1 : leftInteger > rightInteger ? 1 : 0;
  }
  if (left.type === "string" && right.type === "string") {
    return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
  }
  return undefined;
}

function numberOrString(value: string): DatalogValue {
  if (!/^[+-]?\d+$/.test(value)) return stringValue(value);

  try {
    const integer = BigInt(value);
    if (integer >= I64_MIN && integer <= I64_MAX) return integerValue(integer);
  } catch {
    // BigInt can reject only malformed decimal text, which is still a legal Poneglyph Number string.
  }
  return stringValue(value);
}

function toSerdeValue(value: FactValue): unknown {
  switch (value.type) {
    case "null":
      return { type: "null" };
    case "text":
    case "number":
    case "boolean":
    case "bytes":
    case "reference":
    case "date":
    case "date_time":
      return { type: value.type, value: value.value };
    case "list":
    case "map":
      return { type: value.type, value: value.value };
  }
}
