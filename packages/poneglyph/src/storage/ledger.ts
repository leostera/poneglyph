import { parseGraphId, type GraphId } from "../domain/graph-id.js";
import { parseFactBatch, type FactBatch } from "../domain/fact.js";
import { parseTransactionId } from "../domain/identifiers.js";
import { isRecord } from "../domain/result.js";
import { MAX_TRANSACTION_BYTES, TRANSACTION_IDEMPOTENCY_RETENTION_MS } from "./constants.js";
import { LEDGER_BUCKETS, LEDGER_RECOVERY_DELAY_MS, ledgerBucketForTransactionId } from "./forest.js";
import { jsonResponse, readJsonBody } from "./http.js";
import type { StorageEnv } from "./environment.js";
import { DistributedTransaction } from "./transaction.js";
import { BatchCache } from "./batch-cache.js";
import { retainedLedgerOutcomeCount } from "./ledger-capacity.js";

const RECOVERY_BATCH_SIZE = 100;
const RECOVERY_CONCURRENCY = 6;
const RECOVERY_STEP_MS = 10_000;
const SWEEP_BATCH_SIZE = 100;
type Execution = { engine: DistributedTransaction; callers: number };
type Pending = { tx_id: string; graph_id: string; batch_json: string };

// A ledger owns many independent transaction state machines. Only same-ID
// execution is serialized; a network wait never reserves the entire ledger.
export class TransactionLedger {
  private readonly executions = new Map<string, Execution>();
  private readonly cache = new BatchCache();

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly env: StorageEnv,
    private readonly scheduleAlarm: () => Promise<void>,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const raw = await readJsonBody(request, MAX_TRANSACTION_BYTES + 256);
    if (!raw.ok || !isRecord(raw.value)) return jsonResponse({error: "invalid transaction envelope"}, 400);
    const graph = parseGraphId(raw.value["graphId"]), batch = parseFactBatch(raw.value["batch"]);
    if (!graph.ok || !batch.ok) return jsonResponse({error: "invalid graph or fact batch"}, 400);
    const bucket = await ledgerBucketForTransactionId(batch.value.txId);
    if (!this.bindIdentity(graph.value, bucket)) return jsonResponse({error: "transaction escapes its ledger identity"}, 409);
    return this.executeBatch(graph.value, batch.value);
  }

  async status(request: Request): Promise<Response> {
    const raw = await readJsonBody(request, 2_048);
    if (!raw.ok) return jsonResponse({error: raw.error.message}, 400);
    if (!isRecord(raw.value)) return jsonResponse({error: "invalid transaction-status request"}, 400);
    const graph = parseGraphId(raw.value["graphId"]);
    const txId = parseTransactionId(raw.value["txId"]);
    if (!graph.ok || !txId.ok || Object.keys(raw.value).some(key => key !== "graphId" && key !== "txId")) {
      return jsonResponse({error: "invalid transaction-status identity"}, 400);
    }
    return jsonResponse(await this.statusFor(graph.value, txId.value));
  }

  bindIdentity(graphId: string, bucket: string): boolean {
    if (!LEDGER_BUCKETS.includes(bucket)) return false;
    return this.storage.transactionSync(() => {
      const context = this.storage.sql.exec<{graph_id: string; bucket: string}>("SELECT graph_id, bucket FROM ledger_context").toArray()[0];
      if (context) return context.graph_id === graphId && context.bucket === bucket;
      this.storage.sql.exec("INSERT INTO ledger_context VALUES (1, ?, ?)", graphId, bucket);
      return true;
    });
  }

  async statusFor(graphId: string, txId: string): Promise<{phase: string; createdAtMs?: number}> {
    const bucket = await ledgerBucketForTransactionId(txId);
    const context = this.storage.sql.exec<{graph_id: string; bucket: string}>("SELECT graph_id, bucket FROM ledger_context").toArray()[0];
    if (!context || context.graph_id !== graphId || context.bucket !== bucket) return {phase: "missing"};
    const row = this.storage.sql.exec<{phase: string; created_at_ms: number}>(
      "SELECT phase, created_at_ms FROM candidate_transactions WHERE tx_id = ?", txId,
    ).toArray()[0];
    return row === undefined ? {phase: "missing"} : {phase: row.phase, createdAtMs: row.created_at_ms};
  }

  async executeBatch(graph: GraphId, batch: FactBatch): Promise<Response> {
    if (!this.bindIdentity(graph, await ledgerBucketForTransactionId(batch.txId)))
      return jsonResponse({error: "transaction escapes its ledger identity"}, 409);
    return this.execute(graph, batch);
  }

  private async execute(graph: GraphId, batch: FactBatch, recovery = false): Promise<Response> {
    const execution = this.executions.get(batch.txId) ?? {
      engine: new DistributedTransaction(this.storage, this.env, batch.txId, this.scheduleAlarm, this.cache), callers: 0,
    };
    this.executions.set(batch.txId, execution);
    execution.callers++;
    try { return await execution.engine.execute(graph, batch, recovery); }
    finally {
      execution.callers--;
      if (execution.callers === 0) this.executions.delete(batch.txId);
      // A committed/publicly visible transaction must not become a failed
      // acknowledgement merely because terminal maintenance could not rearm.
      // Every pending drive already armed recovery before participant I/O.
      try { await this.scheduleAlarm(); }
      catch (error) { console.error("transaction ledger maintenance deferred", String(error)); }
    }
  }

  async nextMaintenanceAt(): Promise<number | undefined> {
    const pending = this.storage.sql.exec<{due: number | null}>(
      "SELECT MIN(next_recovery_at_ms) AS due FROM candidate_transactions WHERE phase NOT IN ('complete', 'aborted')",
    ).one().due;
    const terminal = this.storage.sql.exec<{due: number | null}>(
      "SELECT MIN(created_at_ms) AS due FROM candidate_transactions WHERE phase IN ('complete', 'aborted')",
    ).one().due;
    const deadlines = [pending, terminal === null ? null : terminal + TRANSACTION_IDEMPOTENCY_RETENTION_MS]
      .filter((value): value is number => value !== null);
    return deadlines.length === 0 ? undefined : Math.min(...deadlines);
  }

  async alarm(): Promise<void> {
    const context = this.storage.sql.exec<{graph_id: string}>("SELECT graph_id FROM ledger_context").toArray()[0];
    if (!context) return; // Facade/tree objects share the class, not its ledger role.
    this.sweepExpired();
    const started = Date.now();
    const due = this.storage.sql.exec<Pending>(
      `SELECT tx_id, graph_id, batch_json FROM candidate_transactions
       WHERE phase NOT IN ('complete', 'aborted') AND next_recovery_at_ms <= ?
       ORDER BY next_recovery_at_ms LIMIT ?`, started, RECOVERY_BATCH_SIZE,
    ).toArray();
    let index = 0;
    const worker = async () => {
      while (index < due.length && Date.now() - started < RECOVERY_STEP_MS) {
        const row = due[index++]!;
        // Move every claimed deadline forward before I/O, including an active
        // caller's intent, so one held request cannot cause an alarm spin.
        this.storage.sql.exec("UPDATE candidate_transactions SET next_recovery_at_ms = ? WHERE tx_id = ?", Date.now() + LEDGER_RECOVERY_DELAY_MS, row.tx_id);
        if (this.executions.has(row.tx_id)) continue;
        const graph = parseGraphId(row.graph_id), batch = parseFactBatch(JSON.parse(row.batch_json));
        if (!graph.ok || !batch.ok) throw new Error("corrupt durable recovery intent");
        try {
          const response = await this.execute(graph.value, batch.value, true);
          await response.arrayBuffer();
        } catch (error) {
          console.error("transaction ledger recovery remains pending", row.tx_id, String(error));
        }
      }
    };
    try { await Promise.all(Array.from({length: RECOVERY_CONCURRENCY}, worker)); }
    finally { await this.scheduleAlarm(); }
  }

  private sweepExpired(): void {
    const expired = this.storage.sql.exec<{tx_id: string}>(
      `SELECT tx_id FROM candidate_transactions WHERE phase IN ('complete', 'aborted')
       AND created_at_ms < ? ORDER BY created_at_ms LIMIT ?`, Date.now() - TRANSACTION_IDEMPOTENCY_RETENTION_MS, SWEEP_BATCH_SIZE,
    ).toArray();
    this.storage.transactionSync(() => {
      for (const row of expired) {
        if (this.executions.has(row.tx_id)) continue;
        this.storage.sql.exec("DELETE FROM candidate_transactions WHERE tx_id = ? AND phase IN ('complete', 'aborted')", row.tx_id);
        this.cache.delete(row.tx_id);
      }
    });
  }
}
