import { parseFactBatch, type FactBatch } from "../domain/fact.js";
import { isRecord, rejected, type ParseResult } from "../domain/result.js";
import { factAsJson } from "./protocol.js";

export async function readJsonBody(
  request: Pick<Request, "body">,
  maxBytes: number,
): Promise<ParseResult<unknown>> {
  if (request.body === null) return rejected("body", "body is required");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return rejected("body", `request body exceeds the ${maxBytes}-byte limit`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return rejected("body", "could not read the request body");
  } finally {
    reader.releaseLock();
  }

  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return rejected("body", "request body must be valid JSON");
  }
}

export function parseBatchBody(input: unknown): ParseResult<Readonly<{ batch: FactBatch; json: string }>> {
  const batch = parseFactBatch(input);
  if (!batch.ok) return batch;
  const json = canonicalBatchJson(batch.value);
  return { ok: true, value: Object.freeze({ batch: batch.value, json }) };
}

export function canonicalBatchJson(batch: FactBatch): string {
  return JSON.stringify({
    txId: batch.txId,
    facts: batch.facts.map(factAsJson),
  });
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function jsonResponse(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return jsonStringResponse(JSON.stringify(body), status, extraHeaders);
}

export function jsonStringResponse(serialized: string, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(serialized, { status, headers });
}

export function requestObject(value: unknown): ParseResult<Record<string, unknown>> {
  return isRecord(value) ? { ok: true, value } : rejected("body", "expected a JSON object");
}
