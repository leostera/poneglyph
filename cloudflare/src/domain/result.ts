export type ParseError = Readonly<{
  path: string;
  message: string;
  offset?: number;
}>;

export type ParseResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: ParseError }>;

export function parsed<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

export function rejected<T = never>(
  path: string,
  message: string,
  offset?: number,
): ParseResult<T> {
  const error = offset === undefined ? { path, message } : { path, message, offset };
  return { ok: false, error };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
