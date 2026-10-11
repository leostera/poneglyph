import type { FactValue } from "../domain/fact-value.js";
import { parseInt64String } from "../domain/int64.js";
import { compareUnicodeScalars } from "../domain/string-order.js";
import { isRecord, parsed, rejected, type ParseResult } from "../domain/result.js";

export type DatalogValue =
  | Readonly<{ type: "string"; value: string }>
  | Readonly<{ type: "integer"; value: string }>;

export function parseDatalogValue(input: unknown, path = "value"): ParseResult<DatalogValue> {
  if (!isRecord(input) || typeof input["type"] !== "string") {
    return rejected(path, "expected a tagged Datalog value");
  }
  if (input["type"] === "string" && typeof input["value"] === "string") {
    return parsed(stringValue(input["value"]));
  }
  if (input["type"] === "integer") {
    const raw = parseInt64String(input["value"], `${path}.value`);
    return raw.ok ? parsed(integerValue(BigInt(raw.value))) : raw;
  }
  return rejected(path, "expected a string or signed 64-bit integer Datalog value");
}

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
    return compareUnicodeScalars(left.value, right.value);
  }
  return undefined;
}

function numberOrString(value: string): DatalogValue {
  const integer = parseInt64String(value, "number");
  return integer.ok ? integerValue(BigInt(integer.value)) : stringValue(value);
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
