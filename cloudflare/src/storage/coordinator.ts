import { DurableObject } from "cloudflare:workers";
import { parseFactBatch, type FactBatch, type FactDraft } from "../domain/fact.js";
import { parseGraphId, type GraphId } from "../domain/graph-id.js";
import { parseUri } from "../domain/identifiers.js";
import { isRecord } from "../domain/result.js";
import { evaluateDatalog, QueryResultLimitExceeded } from "../datalog/evaluator.js";
import { parseDatalogQuery } from "../datalog/parser.js";
import { DistributedFactSource, QueryScanBudgetExceeded } from "./distributed-fact-source.js";
import {
  MAX_QUERY_RESPONSE_BYTES,
  MAX_QUERY_RESULTS,
  MAX_READ_LEASES,
  MAX_TRANSACTION_BYTES,
  MAX_TRANSACTION_FACTS,
  QUERY_TIMEOUT_MS,
  READ_LEASE_TTL_MS,
  ROUTING_VERSION,
  SHARD_COUNT,
} from "./constants.js";
import {
  canonicalBatchJson,
  jsonResponse,
  jsonStringResponse,
  parseBatchBody,
  readJsonBody,
  requestObject,
  sha256Hex,
} from "./http.js";
import { shardIndexForEntity, shardObjectName } from "./keys.js";
import { factAsJson } from "./protocol.js";
import { ensureCoordinatorSchema } from "./sql.js";

const COORDINATOR_NAME_VERSION = 1;

type TransactionPhase = "preparing" | "committing" | "cancelling" | "complete" | "aborted";

type GraphStateRow = Readonly<{
  visible_seq: number;
  writer_tx_id: string | null;
  next_statement_time_ms: number;
}>;

type TransactionRow = Readonly<{
  tx_id: string;
  payload_hash: string;
  batch_json: string | null;
  participants_json: string;
  statement_time_ms: number;
  commit_seq: number;
  phase: TransactionPhase;
  created_at_ms: number;
}>;

type PreparedParticipant = Readonly<{
  shardIndex: number;
  facts: readonly Readonly<{ index: number; fact: FactDraft }>[];
}>;

type ReadLease = Readonly<{ readId: string; snapshotSeq: number; expiresAtMs: number }>;

type ResumeOutcome = "committed" | "aborted";

export class GraphCoordinatorDO extends DurableObject<Env> {
  private activeWriterTxId: string | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => ensureCoordinatorSchema(ctx.storage));
  }

  override async fetch(request: Request): Promise<Response> {
    const route = parseGraphRoute(request);
    if (route === undefined) return jsonResponse({ error: "not found" }, 404);

    try {
      this.assertGraphIdentity(route.graphId);
      if (route.action === "transactions" && request.method === "POST") {
        return await this.writeTransaction(request, route.graphId);
      }
      if (route.action === "query" && request.method === "POST") {
        return await this.runQuery(request, route.graphId);
      }
      if (route.action === "entities" && request.method === "GET") {
        return await this.readEntity(request, route.graphId);
      }
      return jsonResponse({ error: "method not allowed" }, 405);
    } catch (error) {
      const status = error instanceof CoordinatorError ? error.status : 503;
      return jsonResponse({ error: errorMessage(error), retryable: status >= 500 }, status);
    }
  }

  private async writeTransaction(request: Request, graphId: GraphId): Promise<Response> {
    const raw = await readJsonBody(request, MAX_TRANSACTION_BYTES);
    if (!raw.ok) return jsonResponse({ error: raw.error.message, path: raw.error.path }, 400);
    const parsed = parseBatchBody(raw.value);
    if (!parsed.ok) return jsonResponse({ error: parsed.error.message, path: parsed.error.path }, 400);
    const { batch, json } = parsed.value;
    if (batch.facts.length > MAX_TRANSACTION_FACTS) {
      return jsonResponse({ error: `transaction cannot exceed ${MAX_TRANSACTION_FACTS} facts` }, 413);
    }
    if (new TextEncoder().encode(json).byteLength > MAX_TRANSACTION_BYTES) {
      return jsonResponse({ error: `canonical transaction exceeds ${MAX_TRANSACTION_BYTES} bytes` }, 413);
    }

    const payloadHash = await sha256Hex(json);
    if (this.activeWriterTxId !== undefined) {
      return this.writerBusy(this.activeWriterTxId);
    }

    const existingWriter = this.readGraphState().writer_tx_id;
    if (existingWriter !== null) {
      const outcome = await this.resumePersistedWriter(existingWriter);
      if (outcome instanceof Response) return outcome;
    }

    const prior = this.readTransaction(batch.txId);
    if (prior !== undefined) {
      if (prior.payload_hash !== payloadHash) {
        return jsonResponse({ error: "txId has already been used with a different fact batch" }, 409);
      }
      if (prior.phase === "complete") {
        return jsonResponse({ txId: batch.txId, commitSeq: prior.commit_seq, status: "committed" });
      }
      if (prior.phase === "aborted" || prior.phase === "cancelling") {
        return jsonResponse({ txId: batch.txId, status: "aborted" }, 409);
      }
      return jsonResponse({ error: "transaction recovery is in progress; retry with the same txId" }, 503, {
        "retry-after": "1",
      });
    }

    const reservation = this.reserveTransaction(batch, payloadHash, json);
    if (reservation.kind === "busy") return this.writerBusy(reservation.txId);
    if (reservation.kind === "existing") {
      if (reservation.row.payload_hash !== payloadHash) {
        return jsonResponse({ error: "txId has already been used with a different fact batch" }, 409);
      }
      if (reservation.row.phase === "complete") {
        return jsonResponse({ txId: batch.txId, commitSeq: reservation.row.commit_seq, status: "committed" });
      }
      if (reservation.row.phase === "aborted") return jsonResponse({ txId: batch.txId, status: "aborted" }, 409);
      return jsonResponse({ error: "transaction recovery is in progress; retry with the same txId" }, 503);
    }

    this.activeWriterTxId = batch.txId;
    try {
      const outcome = await this.advanceTransaction(batch.txId);
      if (outcome === "aborted") {
        return jsonResponse({ txId: batch.txId, status: "aborted" }, 422);
      }
      const committed = this.readTransaction(batch.txId);
      if (committed === undefined) throw new CoordinatorError(500, "committed transaction record disappeared");
      return jsonResponse({ txId: batch.txId, commitSeq: committed.commit_seq, status: "committed" });
    } catch (error) {
      return jsonResponse({
        error: errorMessage(error),
        txId: batch.txId,
        retryable: true,
      }, 503, { "retry-after": "1" });
    } finally {
      this.activeWriterTxId = undefined;
    }
  }

  private async resumePersistedWriter(txId: string): Promise<ResumeOutcome | Response> {
    if (this.activeWriterTxId !== undefined) return this.writerBusy(this.activeWriterTxId);
    this.activeWriterTxId = txId;
    try {
      return await this.advanceTransaction(txId);
    } catch (error) {
      return jsonResponse({ error: errorMessage(error), txId, retryable: true }, 503, { "retry-after": "1" });
    } finally {
      this.activeWriterTxId = undefined;
    }
  }

  private async advanceTransaction(txId: string): Promise<ResumeOutcome> {
    let transaction = this.readTransaction(txId);
    if (transaction === undefined) throw new CoordinatorError(500, "transaction intent is missing");
    if (transaction.phase === "complete") return "committed";
    if (transaction.phase === "aborted") return "aborted";

    if (transaction.phase === "preparing") {
      if (transaction.batch_json === null) throw new CoordinatorError(500, "preparing transaction has no durable batch payload");
      const batch = parseFactBatch(JSON.parse(transaction.batch_json) as unknown);
      if (!batch.ok) throw new CoordinatorError(500, `stored fact batch is corrupt: ${batch.error.message}`);
      const actualHash = await sha256Hex(canonicalBatchJson(batch.value));
      if (actualHash !== transaction.payload_hash) throw new CoordinatorError(500, "stored fact batch digest mismatch");
      const participants = groupBatch(batch.value);
      if (!sameNumberList(JSON.parse(transaction.participants_json) as unknown, participants.map(({ shardIndex }) => shardIndex))) {
        throw new CoordinatorError(500, "stored participant routes do not match the fixed shard topology");
      }

      const prepareResults = await Promise.allSettled(participants.map((participant) =>
        this.prepareParticipant(this.readGraphIdentity(), transaction!, participant),
      ));
      const permanentFailure = prepareResults.find((result) =>
        result.status === "rejected" && result.reason instanceof ParticipantResponseError && result.reason.status >= 400 && result.reason.status < 500,
      );
      if (permanentFailure !== undefined) {
        this.setTransactionPhase(txId, "cancelling");
        transaction = this.readTransaction(txId);
        if (transaction === undefined) throw new CoordinatorError(500, "transaction intent is missing during cancellation");
        return await this.finishCancellation(transaction);
      }
      const failedPrepare = prepareResults.find((result) => result.status === "rejected");
      if (failedPrepare !== undefined) {
        const reason = failedPrepare.status === "rejected" ? failedPrepare.reason : undefined;
        throw new CoordinatorError(503, `participant prepare is incomplete: ${errorMessage(reason)}`);
      }

      this.setTransactionPhase(txId, "committing");
      transaction = this.readTransaction(txId);
      if (transaction === undefined) throw new CoordinatorError(500, "transaction intent is missing after prepare");
    }

    if (transaction.phase === "cancelling") return await this.finishCancellation(transaction);
    if (transaction.phase !== "committing") throw new CoordinatorError(500, `unexpected transaction phase ${transaction.phase}`);

    const participants = this.readParticipantIndices(transaction);
    const commitResults = await Promise.allSettled(participants.map((shardIndex) =>
      this.commitParticipant(transaction!, shardIndex),
    ));
    const failedCommit = commitResults.find((result) => result.status === "rejected");
    if (failedCommit !== undefined) {
      const reason = failedCommit.status === "rejected" ? failedCommit.reason : undefined;
      throw new CoordinatorError(503, `participant commit is incomplete: ${errorMessage(reason)}`);
    }

    this.publishCommit(transaction);
    await this.pruneVersions();
    return "committed";
  }

  private async finishCancellation(transaction: TransactionRow): Promise<"aborted"> {
    const participants = this.readParticipantIndices(transaction);
    const results = await Promise.allSettled(participants.map((shardIndex) =>
      this.cancelParticipant(transaction, shardIndex),
    ));
    const failure = results.find((result) => result.status === "rejected");
    if (failure !== undefined) {
      const reason = failure.status === "rejected" ? failure.reason : undefined;
      throw new CoordinatorError(503, `participant cancellation is incomplete: ${errorMessage(reason)}`);
    }

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE graph_transactions SET phase = 'aborted', batch_json = NULL WHERE tx_id = ? AND phase = 'cancelling'",
        transaction.tx_id,
      );
      this.ctx.storage.sql.exec(
        "UPDATE graph_state SET writer_tx_id = NULL WHERE singleton = 1 AND writer_tx_id = ?",
        transaction.tx_id,
      );
    });
    return "aborted";
  }

  private reserveTransaction(batch: FactBatch, payloadHash: string, batchJson: string):
    | { kind: "created" }
    | { kind: "busy"; txId: string }
    | { kind: "existing"; row: TransactionRow } {
    return this.ctx.storage.transactionSync(() => {
      const state = this.readGraphState();
      if (state.writer_tx_id !== null) return { kind: "busy", txId: state.writer_tx_id };
      const existing = this.readTransaction(batch.txId);
      if (existing !== undefined) return { kind: "existing", row: existing };

      const participants = groupBatch(batch);
      const commitSeq = state.visible_seq + 1;
      const statementTimeMs = Math.max(Date.now(), state.next_statement_time_ms + 1);
      const nextStatementTimeMs = statementTimeMs + batch.facts.length;
      this.ctx.storage.sql.exec(
        `INSERT INTO graph_transactions
         (tx_id, payload_hash, batch_json, participants_json, statement_time_ms, commit_seq, phase, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, 'preparing', ?)`,
        batch.txId,
        payloadHash,
        batchJson,
        JSON.stringify(participants.map(({ shardIndex }) => shardIndex)),
        statementTimeMs,
        commitSeq,
        Date.now(),
      );
      this.ctx.storage.sql.exec(
        "UPDATE graph_state SET writer_tx_id = ?, next_statement_time_ms = ? WHERE singleton = 1",
        batch.txId,
        nextStatementTimeMs,
      );
      return { kind: "created" };
    });
  }

  private publishCommit(transaction: TransactionRow): void {
    this.ctx.storage.transactionSync(() => {
      const current = this.readGraphState();
      if (current.writer_tx_id !== transaction.tx_id || current.visible_seq + 1 !== transaction.commit_seq) {
        throw new CoordinatorError(500, "graph commit watermark changed while a transaction was applying");
      }
      this.ctx.storage.sql.exec(
        "UPDATE graph_transactions SET phase = 'complete', batch_json = NULL WHERE tx_id = ? AND phase = 'committing'",
        transaction.tx_id,
      );
      this.ctx.storage.sql.exec(
        "UPDATE graph_state SET visible_seq = ?, writer_tx_id = NULL WHERE singleton = 1",
        transaction.commit_seq,
      );
    });
  }

  private setTransactionPhase(txId: string, phase: "committing" | "cancelling"): void {
    this.ctx.storage.transactionSync(() => {
      const tx = this.readTransaction(txId);
      if (tx === undefined) throw new CoordinatorError(500, "transaction intent disappeared");
      if (phase === "committing" && tx.phase !== "preparing") throw new CoordinatorError(500, "invalid commit decision transition");
      if (phase === "cancelling" && tx.phase !== "preparing" && tx.phase !== "cancelling") {
        throw new CoordinatorError(500, "cannot abort after a durable commit decision");
      }
      this.ctx.storage.sql.exec("UPDATE graph_transactions SET phase = ? WHERE tx_id = ?", phase, txId);
    });
  }

  private async prepareParticipant(
    graphId: GraphId,
    transaction: TransactionRow,
    participant: PreparedParticipant,
  ): Promise<void> {
    const body = {
      graphId,
      shardIndex: participant.shardIndex,
      txId: transaction.tx_id,
      payloadHash: transaction.payload_hash,
      statementTimeMs: transaction.statement_time_ms,
      commitSeq: transaction.commit_seq,
      facts: participant.facts,
    };
    await this.callParticipant(participant.shardIndex, "_prepare", body);
  }

  private async commitParticipant(transaction: TransactionRow, shardIndex: number): Promise<void> {
    await this.callParticipant(shardIndex, "_commit", {
      graphId: this.readGraphIdentity(),
      shardIndex,
      txId: transaction.tx_id,
      payloadHash: transaction.payload_hash,
      commitSeq: transaction.commit_seq,
    });
  }

  private async cancelParticipant(transaction: TransactionRow, shardIndex: number): Promise<void> {
    await this.callParticipant(shardIndex, "_cancel", {
      graphId: this.readGraphIdentity(),
      shardIndex,
      txId: transaction.tx_id,
      payloadHash: transaction.payload_hash,
    });
  }

  private async callParticipant(shardIndex: number, path: string, body: unknown): Promise<void> {
    const stub = this.env.GRAPH_SHARDS.getByName(shardObjectName(this.readGraphIdentity(), shardIndex));
    const response = await stub.fetch(`https://shard.internal/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const message = (await response.text()).slice(0, 512);
      throw new ParticipantResponseError(response.status, message);
    }
  }

  private async runQuery(request: Request, graphId: GraphId): Promise<Response> {
    const raw = await readJsonBody(request, 16_384);
    if (!raw.ok) return jsonResponse({ error: raw.error.message }, 400);
    const body = requestObject(raw.value);
    if (!body.ok || typeof body.value["query"] !== "string") {
      return jsonResponse({ error: body.ok ? "query must be a string" : body.error.message }, 400);
    }
    const query = parseDatalogQuery(body.value["query"]);
    if (!query.ok) return jsonResponse({ error: query.error.message, offset: query.error.offset }, 400);

    const lease = this.beginReadLease();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("query time budget exceeded", "TimeoutError")), QUERY_TIMEOUT_MS);
    try {
      const source = new DistributedFactSource(this.env, graphId, lease.snapshotSeq, lease.expiresAtMs);
      const rows: Record<string, unknown>[] = [];
      let responseBytes = 0;
      for await (const binding of evaluateDatalog(query.value, source, {
        maxResults: MAX_QUERY_RESULTS,
        signal: controller.signal,
      })) {
        const row = Object.fromEntries(binding.entries());
        responseBytes += new TextEncoder().encode(JSON.stringify(row)).byteLength + 1;
        if (responseBytes > MAX_QUERY_RESPONSE_BYTES) throw new CoordinatorError(413, "query response byte budget exceeded");
        rows.push(row);
      }
      const serialized = JSON.stringify({
        rows,
        snapshotSeq: lease.snapshotSeq,
        metrics: source.metrics,
      });
      if (new TextEncoder().encode(serialized).byteLength > MAX_QUERY_RESPONSE_BYTES) {
        throw new CoordinatorError(413, "query response byte budget exceeded");
      }
      return jsonStringResponse(serialized);
    } catch (error) {
      const status = error instanceof QueryResultLimitExceeded || error instanceof QueryScanBudgetExceeded
        ? 413
        : error instanceof CoordinatorError
          ? error.status
          : controller.signal.aborted
            ? 408
            : 502;
      return jsonResponse({ error: errorMessage(error), snapshotSeq: lease.snapshotSeq }, status);
    } finally {
      clearTimeout(timer);
      const minSnapshotSeq = this.releaseReadLease(lease.readId);
      await this.pruneVersions(minSnapshotSeq);
    }
  }

  private async readEntity(request: Request, graphId: GraphId): Promise<Response> {
    const entity = parseUri(new URL(request.url).searchParams.get("uri"), "uri");
    if (!entity.ok) return jsonResponse({ error: entity.error.message }, 400);
    const lease = this.beginReadLease();
    try {
      const shardIndex = shardIndexForEntity(entity.value);
      const stub = this.env.GRAPH_SHARDS.getByName(shardObjectName(graphId, shardIndex));
      const response = await stub.fetch("https://shard.internal/_entity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          graphId,
          shardIndex,
          entity: entity.value,
          snapshotSeq: lease.snapshotSeq,
          leaseExpiresAtMs: lease.expiresAtMs,
        }),
      });
      if (response.status === 404) return jsonResponse({ entity: null, snapshotSeq: lease.snapshotSeq });
      if (!response.ok) return jsonResponse({ error: (await response.text()).slice(0, 512) }, 502);
      const projection: unknown = await response.json();
      return jsonResponse({ entity: projection, snapshotSeq: lease.snapshotSeq });
    } finally {
      const minSnapshotSeq = this.releaseReadLease(lease.readId);
      await this.pruneVersions(minSnapshotSeq);
    }
  }

  private beginReadLease(): ReadLease {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      this.ctx.storage.sql.exec("DELETE FROM graph_read_leases WHERE expires_at_ms <= ?", now);
      const leaseCount = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM graph_read_leases WHERE expires_at_ms > ?",
        now,
      ).toArray()[0]?.count ?? 0;
      if (leaseCount >= MAX_READ_LEASES) throw new CoordinatorError(429, "graph has reached its concurrent read-lease limit");
      const graph = this.readGraphState();
      const readId = crypto.randomUUID();
      const expiresAtMs = now + READ_LEASE_TTL_MS;
      this.ctx.storage.sql.exec(
        "INSERT INTO graph_read_leases (read_id, snapshot_seq, expires_at_ms) VALUES (?, ?, ?)",
        readId,
        graph.visible_seq,
        expiresAtMs,
      );
      return { readId, snapshotSeq: graph.visible_seq, expiresAtMs };
    });
  }

  private releaseReadLease(readId: string): number {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      this.ctx.storage.sql.exec("DELETE FROM graph_read_leases WHERE read_id = ? OR expires_at_ms <= ?", readId, now);
      const lease = this.ctx.storage.sql.exec<{ min_seq: number | null }>(
        "SELECT MIN(snapshot_seq) AS min_seq FROM graph_read_leases WHERE expires_at_ms > ?",
        now,
      ).toArray()[0];
      return lease?.min_seq ?? this.readGraphState().visible_seq;
    });
  }

  private async pruneVersions(minSnapshotSeq?: number): Promise<void> {
    const minSnapshot = minSnapshotSeq ?? this.minimumSnapshotSeq();
    const graphId = this.readGraphIdentity();
    await Promise.allSettled(Array.from({ length: SHARD_COUNT }, async (_, shardIndex) => {
      const stub = this.env.GRAPH_SHARDS.getByName(shardObjectName(graphId, shardIndex));
      const response = await stub.fetch("https://shard.internal/_prune", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ graphId, shardIndex, minSnapshotSeq: minSnapshot }),
      });
      if (!response.ok) console.warn("Poneglyph projection pruning deferred", shardIndex, response.status);
    }));
  }

  private minimumSnapshotSeq(): number {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      this.ctx.storage.sql.exec("DELETE FROM graph_read_leases WHERE expires_at_ms <= ?", now);
      const lease = this.ctx.storage.sql.exec<{ min_seq: number | null }>(
        "SELECT MIN(snapshot_seq) AS min_seq FROM graph_read_leases WHERE expires_at_ms > ?",
        now,
      ).toArray()[0];
      return lease?.min_seq ?? this.readGraphState().visible_seq;
    });
  }

  private readGraphState(): GraphStateRow {
    const row = this.ctx.storage.sql.exec<GraphStateRow>(
      "SELECT visible_seq, writer_tx_id, next_statement_time_ms FROM graph_state WHERE singleton = 1",
    ).toArray()[0];
    if (row === undefined) throw new CoordinatorError(500, "graph state row is missing");
    return row;
  }

  private readTransaction(txId: string): TransactionRow | undefined {
    return this.ctx.storage.sql.exec<TransactionRow>(
      `SELECT tx_id, payload_hash, batch_json, participants_json, statement_time_ms,
              commit_seq, phase, created_at_ms
       FROM graph_transactions WHERE tx_id = ?`,
      txId,
    ).toArray()[0];
  }

  private readParticipantIndices(transaction: TransactionRow): readonly number[] {
    let input: unknown;
    try {
      input = JSON.parse(transaction.participants_json) as unknown;
    } catch {
      throw new CoordinatorError(500, "stored participant list is corrupt");
    }
    if (!Array.isArray(input) || input.length === 0 || input.some((value) =>
      typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= SHARD_COUNT,
    )) {
      throw new CoordinatorError(500, "stored participant list is invalid");
    }
    return input as number[];
  }

  private assertGraphIdentity(graphId: GraphId): void {
    this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{ graph_id: string; routing_version: number }>(
        "SELECT graph_id, routing_version FROM graph_identity WHERE singleton = 1",
      ).toArray()[0];
      if (row === undefined) {
        this.ctx.storage.sql.exec(
          "INSERT INTO graph_identity (singleton, graph_id, routing_version) VALUES (1, ?, ?)",
          graphId,
          ROUTING_VERSION,
        );
        return;
      }
      if (row.graph_id !== graphId || row.routing_version !== ROUTING_VERSION) {
        throw new CoordinatorError(409, "coordinator Durable Object is bound to a different graph or routing version");
      }
    });
  }

  private readGraphIdentity(): GraphId {
    const row = this.ctx.storage.sql.exec<{ graph_id: string }>(
      "SELECT graph_id FROM graph_identity WHERE singleton = 1",
    ).toArray()[0];
    const graphId = parseGraphId(row?.graph_id);
    if (!graphId.ok) throw new CoordinatorError(500, "coordinator graph identity is missing or corrupt");
    return graphId.value;
  }

  private writerBusy(txId: string): Response {
    return jsonResponse({ error: "another graph transaction is being recovered or committed", txId, retryable: true }, 423, {
      "retry-after": "1",
    });
  }
}

function parseGraphRoute(request: Request): Readonly<{ graphId: GraphId; action: "transactions" | "query" | "entities" }> | undefined {
  const match = /^\/v1\/graphs\/([a-z0-9-]+)\/(transactions|query|entities)$/.exec(new URL(request.url).pathname);
  if (match === null) return undefined;
  const graphId = parseGraphId(match[1]);
  if (!graphId.ok) return undefined;
  const action = match[2];
  if (action !== "transactions" && action !== "query" && action !== "entities") return undefined;
  return { graphId: graphId.value, action };
}

function groupBatch(batch: FactBatch): PreparedParticipant[] {
  const groups = new Map<number, { index: number; fact: FactDraft }[]>();
  for (const [index, fact] of batch.facts.entries()) {
    const shardIndex = shardIndexForEntity(fact.entity);
    const group = groups.get(shardIndex) ?? [];
    group.push({ index, fact: factAsJson(fact) });
    groups.set(shardIndex, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([shardIndex, facts]) => ({ shardIndex, facts }));
}

function sameNumberList(input: unknown, expected: readonly number[]): boolean {
  return Array.isArray(input) && input.length === expected.length &&
    input.every((value, index) => value === expected[index]);
}

class ParticipantResponseError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ParticipantResponseError";
  }
}

class CoordinatorError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "CoordinatorError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
