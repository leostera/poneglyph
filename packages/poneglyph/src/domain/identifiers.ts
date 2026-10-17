import { isRfc3339Timestamp } from "./date-validation.js";
import { parsed, rejected, type ParseResult } from "./result.js";

declare const uriBrand: unique symbol;
declare const factIdBrand: unique symbol;
declare const transactionIdBrand: unique symbol;
declare const clientRequestTokenBrand: unique symbol;
declare const statedAtBrand: unique symbol;

export type Uri = string & { readonly [uriBrand]: "Uri" };
export type FactId = Uri & { readonly [factIdBrand]: "FactId" };
export type TransactionId = Uri & { readonly [transactionIdBrand]: "TransactionId" };
export type ClientRequestToken = string & { readonly [clientRequestTokenBrand]: "ClientRequestToken" };
export type StatedAt = string & { readonly [statedAtBrand]: "StatedAt" };

export const MAX_URI_LENGTH = 2_048;
export const MAX_TRANSACTION_ID_BYTES = 256;
export const MAX_CLIENT_REQUEST_TOKEN_BYTES = 256;

export function parseUri(input: unknown, path = "uri"): ParseResult<Uri> {
  if (typeof input !== "string" || input.length === 0) {
    return rejected(path, "expected a non-empty URI string");
  }
  if (input.length > MAX_URI_LENGTH) {
    return rejected(path, `URI cannot exceed ${MAX_URI_LENGTH} characters`);
  }

  try {
    return parsed(new URL(input).href as Uri);
  } catch {
    return rejected(path, "expected an absolute URI with a scheme");
  }
}

export function parseFactId(input: unknown, path = "factId"): ParseResult<FactId> {
  const uri = parseUri(input, path);
  return uri.ok ? parsed(uri.value as FactId) : uri;
}

export function parseTransactionId(
  input: unknown,
  path = "txId",
): ParseResult<TransactionId> {
  if (typeof input === "string" && new TextEncoder().encode(input).byteLength > MAX_TRANSACTION_ID_BYTES) {
    return rejected(path, `transaction ID cannot exceed ${MAX_TRANSACTION_ID_BYTES} UTF-8 bytes`);
  }
  const uri = parseUri(input, path);
  return uri.ok ? parsed(uri.value as TransactionId) : uri;
}

export function parseClientRequestToken(
  input: unknown,
  path = "clientRequestToken",
): ParseResult<ClientRequestToken> {
  if (typeof input !== "string" || input.length === 0) {
    return rejected(path, "expected a non-empty client request token");
  }
  if (new TextEncoder().encode(input).byteLength > MAX_CLIENT_REQUEST_TOKEN_BYTES) {
    return rejected(path, `client request token cannot exceed ${MAX_CLIENT_REQUEST_TOKEN_BYTES} UTF-8 bytes`);
  }
  return parsed(input as ClientRequestToken);
}

export function parseStatedAt(input: unknown, path = "statedAt"): ParseResult<StatedAt> {
  if (typeof input !== "string" || !isRfc3339Timestamp(input)) {
    return rejected(path, "expected an RFC 3339 timestamp with a timezone");
  }

  return parsed(input as StatedAt);
}
