import { parsed, rejected, type ParseResult } from "./result.js";

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

export function parseInt64String(input: unknown, path: string): ParseResult<string> {
  if (typeof input !== "string" || !/^-?(?:0|[1-9][0-9]*)$/.test(input)) {
    return rejected(path, "expected a canonical signed 64-bit integer string");
  }
  try {
    const integer = BigInt(input);
    if (integer >= I64_MIN && integer <= I64_MAX && integer.toString() === input) {
      return parsed(input);
    }
  } catch {
    // Return a parse error for integer strings that cannot be represented.
  }
  return rejected(path, "integer is outside the signed 64-bit range");
}
