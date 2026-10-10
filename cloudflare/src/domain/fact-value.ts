import { isCalendarDate, isRfc3339Timestamp } from "./date-validation.js";
import { isRecord, parsed, rejected, type ParseResult } from "./result.js";

export type FactValue =
  | Readonly<{ type: "null" }>
  | Readonly<{ type: "text"; value: string }>
  | Readonly<{ type: "number"; value: string }>
  | Readonly<{ type: "boolean"; value: boolean }>
  | Readonly<{ type: "bytes"; value: readonly number[] }>
  | Readonly<{ type: "reference"; value: string }>
  | Readonly<{ type: "date"; value: string }>
  | Readonly<{ type: "date_time"; value: string }>
  | Readonly<{ type: "list"; value: readonly FactValue[] }>
  | Readonly<{ type: "map"; value: Readonly<Record<string, FactValue>> }>;

const MAX_VALUE_DEPTH = 64;

export function parseFactValue(input: unknown, path = "value"): ParseResult<FactValue> {
  return parseAtDepth(input, path, 0);
}

function parseAtDepth(input: unknown, path: string, depth: number): ParseResult<FactValue> {
  if (depth > MAX_VALUE_DEPTH) {
    return rejected(path, `fact values cannot be nested more than ${MAX_VALUE_DEPTH} levels`);
  }
  if (!isRecord(input) || typeof input["type"] !== "string") {
    return rejected(path, "expected a tagged fact value");
  }

  switch (input["type"]) {
    case "null":
      if (input["value"] !== undefined && input["value"] !== null) {
        return rejected(`${path}.value`, "null values cannot carry a payload");
      }
      return parsed(Object.freeze({ type: "null" }));
    case "text":
    case "number": {
      if (typeof input["value"] !== "string") {
        return rejected(`${path}.value`, `expected a string for ${input["type"]}`);
      }
      return parsed(Object.freeze({ type: input["type"], value: input["value"] }));
    }
    case "boolean":
      return typeof input["value"] === "boolean"
        ? parsed(Object.freeze({ type: "boolean", value: input["value"] }))
        : rejected(`${path}.value`, "expected a boolean");
    case "bytes":
      return parseBytes(input["value"], `${path}.value`);
    case "reference": {
      if (typeof input["value"] !== "string") {
        return rejected(`${path}.value`, "expected a URI string for reference");
      }
      try {
        const uri = new URL(input["value"]).href;
        return parsed(Object.freeze({ type: "reference", value: uri }));
      } catch {
        return rejected(`${path}.value`, "expected an absolute reference URI");
      }
    }
    case "date":
      return parseDate(input["value"], `${path}.value`);
    case "date_time":
      return parseDateTime(input["value"], `${path}.value`);
    case "list":
      return parseList(input["value"], `${path}.value`, depth);
    case "map":
      return parseMap(input["value"], `${path}.value`, depth);
    default:
      return rejected(`${path}.type`, `unsupported fact value tag: ${input["type"]}`);
  }
}

function parseBytes(input: unknown, path: string): ParseResult<FactValue> {
  if (!Array.isArray(input)) {
    return rejected(path, "expected an array of byte values");
  }

  const bytes: number[] = [];
  for (const [index, byte] of input.entries()) {
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      return rejected(`${path}[${index}]`, "expected an integer between 0 and 255");
    }
    bytes.push(byte);
  }

  return parsed(Object.freeze({ type: "bytes", value: Object.freeze(bytes) }));
}

function parseDate(input: unknown, path: string): ParseResult<FactValue> {
  if (typeof input !== "string" || !isCalendarDate(input)) {
    return rejected(path, "expected a valid calendar date in YYYY-MM-DD form");
  }

  return parsed(Object.freeze({ type: "date", value: input }));
}

function parseDateTime(input: unknown, path: string): ParseResult<FactValue> {
  if (typeof input !== "string" || !isRfc3339Timestamp(input)) {
    return rejected(path, "expected an RFC 3339 timestamp with a timezone");
  }

  return parsed(Object.freeze({ type: "date_time", value: input }));
}

function parseList(input: unknown, path: string, depth: number): ParseResult<FactValue> {
  if (!Array.isArray(input)) {
    return rejected(path, "expected an array of fact values");
  }

  const values: FactValue[] = [];
  for (const [index, item] of input.entries()) {
    const value = parseAtDepth(item, `${path}[${index}]`, depth + 1);
    if (!value.ok) return value;
    values.push(value.value);
  }

  return parsed(Object.freeze({ type: "list", value: Object.freeze(values) }));
}

function parseMap(input: unknown, path: string, depth: number): ParseResult<FactValue> {
  if (!isRecord(input)) {
    return rejected(path, "expected an object of fact values");
  }

  const entries = Object.entries(input).sort(([left], [right]) => left.localeCompare(right));
  const values: Record<string, FactValue> = Object.create(null) as Record<string, FactValue>;
  for (const [key, item] of entries) {
    const value = parseAtDepth(item, `${path}.${key}`, depth + 1);
    if (!value.ok) return value;
    values[key] = value.value;
  }

  return parsed(Object.freeze({ type: "map", value: Object.freeze(values) }));
}
