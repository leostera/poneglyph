import { parseFactBatch, type FactDraft } from "../domain/fact.js";
import { parseGraphId, type GraphId } from "../domain/graph-id.js";
import { parseClientRequestToken } from "../domain/identifiers.js";
import { isRecord } from "../domain/result.js";
import { MAX_TRANSACTION_BYTES, MAX_TRANSACTION_FACTS, TRANSACTION_IDEMPOTENCY_RETENTION_MS } from "./constants.js";
import { LEDGER_OUTCOME_LIMIT, ledgerBucketForRequestToken, transactionIdForLedgerBucket } from "./forest.js";
import type { TransactionLedger } from "./ledger.js";
import { retainedLedgerOutcomeCount } from "./ledger-capacity.js";
import { accountStorage } from "./capacity.js";
import { canonicalBatchJson, jsonResponse, readJsonBody, sha256Hex } from "./http.js";
import { factAsJson } from "./protocol.js";
import { publicTransactionResponse } from "./transaction-request.js";

const TOKEN_MAINTENANCE_BATCH_SIZE = 100;
const PENDING_STATUS_CHECK_MS = 30_000;
const VALIDATION_TX_ID = "poneglyph:tx:00000000-0000-4000-8000-000000000000";

type RequestTokenRow = Readonly<{
  token_hash: string;
  payload_hash: string;
  tx_id: string;
  created_at_ms: number;
  terminal_at_ms: number | null;
  terminal_status: "committed" | "aborted" | null;
}>;

type TokenResponse = Readonly<{status: number; headers: HeadersInit; body: string}>;

export class ClientRequestTokenCoordinator {
  private readonly inFlight = new Map<string, Readonly<{payloadHash: string; result: Promise<TokenResponse>}>>();

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly ledger: TransactionLedger,
    private readonly scheduleAlarm: () => Promise<void>,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const raw = await readJsonBody(request, MAX_TRANSACTION_BYTES + 1_024);
    if (!raw.ok || !isRecord(raw.value)) return jsonResponse({error: "invalid transaction request"}, 400);
    if (Object.keys(raw.value).some(key => !["graphId", "clientRequestToken", "facts"].includes(key))) {
      return jsonResponse({error: "request-token transactions accept graphId, clientRequestToken, and facts"}, 400);
    }

    const graph = parseGraphId(raw.value["graphId"]);
    const token = parseClientRequestToken(raw.value["clientRequestToken"]);
    if (!graph.ok || !token.ok) return jsonResponse({error: "invalid graph or client request token"}, 400);
    const validation = parseFactBatch({txId: VALIDATION_TX_ID, facts: raw.value["facts"]});
    if (!validation.ok) return jsonResponse({error: validation.error.message}, 400);
    if (validation.value.facts.length > MAX_TRANSACTION_FACTS) {
      return jsonResponse({error: "transaction exceeds fact limit", retryable: false}, 413);
    }
    if (new TextEncoder().encode(canonicalBatchJson(validation.value)).byteLength > MAX_TRANSACTION_BYTES) {
      return jsonResponse({error: "transaction exceeds byte limit", retryable: false}, 413);
    }

    const normalizedFacts = validation.value.facts;
    const payloadHash = await sha256Hex(JSON.stringify(normalizedFacts.map(factAsJson)));
    const tokenHash = await sha256Hex(`${graph.value}\u0000${token.value}`);
    const bucket = await ledgerBucketForRequestToken(graph.value, token.value);
    if (!this.ledger.bindIdentity(graph.value, bucket)) {
      return jsonResponse({error: "request token escapes its ledger identity"}, 409);
    }

    const active = this.inFlight.get(tokenHash);
    if (active !== undefined) {
      if (active.payloadHash !== payloadHash) return jsonResponse({error: "clientRequestToken was already used with different facts"}, 409);
      return toResponse(await active.result);
    }

    const selected = this.selectOrCreate(tokenHash, payloadHash);
    if (selected.kind === "conflict") return jsonResponse({error: "clientRequestToken was already used with different facts"}, 409);
    if (selected.kind === "capacity") return jsonResponse({error: selected.message, retryable: false}, selected.status);

    const result = this.drive(graph.value, normalizedFacts, selected.row);
    this.inFlight.set(tokenHash, {payloadHash, result});
    try { return toResponse(await result); }
    finally { this.inFlight.delete(tokenHash); }
  }

  async alarm(): Promise<void> {
    const context = this.storage.sql.exec<{graph_id: string}>(
      "SELECT graph_id FROM ledger_context WHERE singleton = 1",
    ).toArray()[0];
    if (!context) return;

    const now = Date.now();
    this.pruneExpired(now);
    const pending = this.storage.sql.exec<RequestTokenRow>(
      `SELECT * FROM client_request_tokens WHERE terminal_at_ms IS NULL ORDER BY created_at_ms LIMIT ?`,
      TOKEN_MAINTENANCE_BATCH_SIZE,
    ).toArray();
    for (const row of pending) {
      if (this.inFlight.has(row.token_hash)) continue;
      try {
        const status = await this.ledger.statusFor(context.graph_id, row.tx_id);
        if (status.phase === "complete" || status.phase === "aborted") {
          this.markTerminal(row.token_hash, status.phase === "complete" ? "committed" : "aborted");
        } else if (status.phase === "missing" && row.created_at_ms + TRANSACTION_IDEMPOTENCY_RETENTION_MS <= now) {
          this.storage.sql.exec("DELETE FROM client_request_tokens WHERE token_hash = ? AND terminal_at_ms IS NULL", row.token_hash);
        }
      } catch {
        console.warn("request-token outcome reconciliation deferred");
      }
    }
    await this.scheduleAlarm();
  }

  private selectOrCreate(tokenHash: string, payloadHash: string):
    | Readonly<{kind: "selected"; row: RequestTokenRow}>
    | Readonly<{kind: "conflict"}>
    | Readonly<{kind: "capacity"; status: number; message: string}> {
    return this.storage.transactionSync(() => {
      const now = Date.now();
      this.pruneExpired(now);
      let row = this.read(tokenHash);
      if (row?.terminal_at_ms !== null && row?.terminal_at_ms !== undefined &&
          row.created_at_ms + TRANSACTION_IDEMPOTENCY_RETENTION_MS <= now) {
        this.storage.sql.exec("DELETE FROM client_request_tokens WHERE token_hash = ?", tokenHash);
        row = undefined;
      }
      if (row !== undefined) return row.payload_hash === payloadHash ? {kind: "selected", row} : {kind: "conflict"};

      const count = retainedLedgerOutcomeCount(this.storage);
      if (count + 2 > LEDGER_OUTCOME_LIMIT) {
        return {kind: "capacity", status: 429, message: "ledger reached its shared retained-outcome allocation"};
      }
      const capacity = accountStorage(this.storage.sql.databaseSize, {
        factLogBytes: 0, activeIndexBytes: 0, projectionBytes: 0, transactionStagingBytes: 1_024,
      });
      if (!capacity.canAdmit) return {kind: "capacity", status: 413, message: "request-token metadata capacity exceeded"};

      const txId = transactionIdForLedgerBucket(tokenHash[0]!);
      this.storage.sql.exec(
        `INSERT INTO client_request_tokens (token_hash, payload_hash, tx_id, created_at_ms, terminal_at_ms, terminal_status)
         VALUES (?, ?, ?, ?, NULL, NULL)`,
        tokenHash, payloadHash, txId, now,
      );
      return {kind: "selected", row: this.read(tokenHash)!};
    });
  }

  private async drive(graphId: GraphId, facts: readonly FactDraft[], row: RequestTokenRow): Promise<TokenResponse> {
    try {
      await this.scheduleAlarm();
      const batch = parseFactBatch({txId: row.tx_id, facts});
      if (!batch.ok) return await responseData(jsonResponse({error: "stored request-token facts are invalid", retryable: false}, 400));
      if (new TextEncoder().encode(canonicalBatchJson(batch.value)).byteLength > MAX_TRANSACTION_BYTES) {
        return await responseData(jsonResponse({error: "transaction exceeds byte limit", retryable: false}, 413));
      }
      const response = await this.ledger.executeBatch(graphId, batch.value);
      const commit = response.ok ? await response.clone().json().catch(() => undefined) : undefined;
      if (isRecord(commit) && commit["txId"] === row.tx_id && commit["status"] === "committed") {
        this.markTerminal(row.token_hash, "committed");
      } else if (response.status === 422) {
        this.markTerminal(row.token_hash, "aborted");
      }
      const publicResponse = await publicTransactionResponse(response, row.tx_id);
      return await responseData(publicResponse);
    } catch {
      return await responseData(jsonResponse({error: "transaction delivery is unavailable; retry with the same clientRequestToken and facts", retryable: true}, 503));
    } finally {
      try { await this.scheduleAlarm(); }
      catch { console.warn("request-token retention scheduling deferred"); }
    }
  }

  private read(tokenHash: string): RequestTokenRow | undefined {
    return this.storage.sql.exec<RequestTokenRow>("SELECT * FROM client_request_tokens WHERE token_hash = ?", tokenHash).toArray()[0];
  }

  private markTerminal(tokenHash: string, status: "committed" | "aborted"): void {
    this.storage.sql.exec(
      `UPDATE client_request_tokens SET terminal_at_ms = COALESCE(terminal_at_ms, ?),
       terminal_status = COALESCE(terminal_status, ?) WHERE token_hash = ?`,
      Date.now(), status, tokenHash,
    );
  }

  private pruneExpired(now: number): void {
    this.storage.sql.exec(
      `DELETE FROM client_request_tokens WHERE token_hash IN (
         SELECT token_hash FROM client_request_tokens WHERE terminal_at_ms IS NOT NULL
         AND created_at_ms + ? <= ? ORDER BY created_at_ms LIMIT ?
       )`,
      TRANSACTION_IDEMPOTENCY_RETENTION_MS, now, TOKEN_MAINTENANCE_BATCH_SIZE,
    );
  }

  async nextMaintenanceAt(): Promise<number | undefined> {
    const pending = this.storage.sql.exec<{count: number}>(
      "SELECT COUNT(*) AS count FROM client_request_tokens WHERE terminal_at_ms IS NULL",
    ).one().count;
    const terminal = this.storage.sql.exec<{due: number | null}>(
      "SELECT MIN(created_at_ms) AS due FROM client_request_tokens WHERE terminal_at_ms IS NOT NULL",
    ).one().due;
    return pending > 0 ? Date.now() + PENDING_STATUS_CHECK_MS
      : terminal === null ? undefined : terminal + TRANSACTION_IDEMPOTENCY_RETENTION_MS;
  }
}

async function responseData(response: Response): Promise<TokenResponse> {
  const headers = new Headers();
  const contentType = response.headers.get("content-type");
  const retryAfter = response.headers.get("retry-after");
  if (contentType !== null) headers.set("content-type", contentType);
  if (retryAfter !== null) headers.set("retry-after", retryAfter);
  return {status: response.status, headers, body: await response.text()};
}

function toResponse(value: TokenResponse): Response {
  return new Response(value.body, {status: value.status, headers: value.headers});
}
