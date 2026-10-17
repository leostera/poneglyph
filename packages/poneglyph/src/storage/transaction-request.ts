import { parseFactBatch, type FactBatch } from "../domain/fact.js";
import { parseClientRequestToken } from "../domain/identifiers.js";
import type { StorageEnv } from "./environment.js";
import { tokenLedgerName, transactionCoordinatorName } from "./forest.js";
import { isRecord } from "../domain/result.js";
import { MAX_TRANSACTION_BYTES, MAX_TRANSACTION_FACTS } from "./constants.js";
import { canonicalBatchJson, jsonResponse, readJsonBody } from "./http.js";

const MAX_PUBLIC_TRANSACTION_ENVELOPE_BYTES = MAX_TRANSACTION_BYTES + 1_024;

export async function dispatchPublicTransaction(
  request: Request,
  env: StorageEnv,
  graphId: string,
): Promise<Response> {
  const raw = await readJsonBody(request, MAX_PUBLIC_TRANSACTION_ENVELOPE_BYTES);
  if (!raw.ok) return jsonResponse({error: raw.error.message}, 400);
  if (!isRecord(raw.value)) return jsonResponse({error: "invalid transaction request"}, 400);
  if (!Object.hasOwn(raw.value, "facts") || Object.keys(raw.value).some(key => key !== "facts" && key !== "clientRequestToken")) {
    return jsonResponse({error: "transaction requests accept facts and an optional clientRequestToken"}, 400);
  }

  const facts = raw.value["facts"];
  const parsedToken = raw.value["clientRequestToken"] === undefined
    ? undefined
    : parseClientRequestToken(raw.value["clientRequestToken"]);
  if (parsedToken !== undefined && !parsedToken.ok) return jsonResponse({error: parsedToken.error.message}, 400);

  if (parsedToken !== undefined) {
    const token = parsedToken.value;
    return env.GRAPH_LEDGERS.getByName(await tokenLedgerName(graphId, token)).fetch("https://ledger.internal/_request", {
      method: "POST",
      body: JSON.stringify({graphId, clientRequestToken: token, facts}),
    });
  }

  const txId = createTransactionId();
  const parsedBatch = parseFactBatch({txId, facts});
  if (!parsedBatch.ok) return jsonResponse({error: parsedBatch.error.message}, 400);
  if (parsedBatch.value.facts.length > MAX_TRANSACTION_FACTS ||
      new TextEncoder().encode(canonicalBatchJson(parsedBatch.value)).byteLength > MAX_TRANSACTION_BYTES) {
    return jsonResponse({error: "transaction exceeds fact/byte limits", retryable: false}, 413);
  }

  const response = await dispatchInternalTransaction(env, graphId, parsedBatch.value);
  return publicTransactionResponse(response, txId);
}

export async function dispatchInternalTransaction(
  env: StorageEnv,
  graphId: string,
  batch: FactBatch,
): Promise<Response> {
  return env.GRAPH_LEDGERS.getByName(await transactionCoordinatorName(graphId, batch.txId)).fetch("https://ledger.internal/_transact", {
    method: "POST",
    body: JSON.stringify({graphId, batch}),
  });
}

export async function publicTransactionResponse(response: Response, expectedTxId: string): Promise<Response> {
  if (response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    if (!isRecord(body) || body["txId"] !== expectedTxId || body["status"] !== "committed" ||
        typeof body["commitSeq"] !== "number" || !Number.isSafeInteger(body["commitSeq"]) || body["commitSeq"] < 1) {
      return jsonResponse({error: "transaction coordinator returned an invalid or unreadable commit witness", retryable: true}, 502);
    }
    return jsonResponse({txId: expectedTxId});
  }

  const text = await response.text().catch(() => "");
  let body: unknown;
  try { body = JSON.parse(text) as unknown; } catch { body = undefined; }
  if (!isRecord(body)) return jsonResponse({error: "transaction was not acknowledged", retryable: response.status >= 500}, response.status);
  const publicFields = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "txId"));
  const headers = new Headers();
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) headers.set("retry-after", retryAfter);
  return jsonResponse(publicFields, response.status, headers);
}

function createTransactionId(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") throw new Error("server transaction ID generation is unavailable");
  return `poneglyph:tx:${globalThis.crypto.randomUUID()}`;
}
