import { parseGraphId, type GraphId } from "../domain/graph-id.js";
import { parseFactBatch, type FactBatch } from "../domain/fact.js";
import { isRecord } from "../domain/result.js";
import { MAX_TRANSACTION_BYTES, TRANSACTION_IDEMPOTENCY_RETENTION_MS } from "./constants.js";
import { LEDGER_RECOVERY_DELAY_MS } from "./forest.js";
import { jsonResponse, readJsonBody, sha256Hex } from "./http.js";
import type { CandidateStorageEnv } from "./environment.js";
import { DistributedTransaction } from "./transaction.js";

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

  constructor(private readonly storage: DurableObjectStorage, private readonly env: CandidateStorageEnv) {}

  async fetch(request: Request): Promise<Response> {
    const raw = await readJsonBody(request, MAX_TRANSACTION_BYTES + 256);
    if (!raw.ok || !isRecord(raw.value)) return jsonResponse({error: "invalid transaction envelope"}, 400);
    const graph = parseGraphId(raw.value["graphId"]), batch = parseFactBatch(raw.value["batch"]);
    if (!graph.ok || !batch.ok) return jsonResponse({error: "invalid graph or fact batch"}, 400);
    const bucket = (await sha256Hex(batch.value.txId)).slice(0, 1);
    const context = this.storage.sql.exec<{graph_id: string; bucket: string}>("SELECT graph_id, bucket FROM ledger_context").toArray()[0];
    if (context && (context.graph_id !== graph.value || context.bucket !== bucket))
      return jsonResponse({error: "transaction escapes its ledger identity"}, 409);
    if (!context) this.storage.sql.exec("INSERT INTO ledger_context VALUES (1, ?, ?)", graph.value, bucket);
    return this.execute(graph.value, batch.value);
  }

  private async execute(graph: GraphId, batch: FactBatch): Promise<Response> {
    const execution = this.executions.get(batch.txId) ?? {
      engine: new DistributedTransaction(this.storage, this.env, batch.txId, () => this.schedule()), callers: 0,
    };
    this.executions.set(batch.txId, execution);
    execution.callers++;
    try { return await execution.engine.execute(graph, batch); }
    finally {
      execution.callers--;
      if (execution.callers === 0) this.executions.delete(batch.txId);
      // A committed/publicly visible transaction must not become a failed
      // acknowledgement merely because terminal maintenance could not rearm.
      // Every pending drive already armed recovery before participant I/O.
      try { await this.schedule(); }
      catch (error) { console.error("transaction ledger maintenance deferred", String(error)); }
    }
  }

  // Only indexed deadlines drive the alarm. Audits never invoke this method.
  private async schedule(): Promise<void> {
    const pending = this.storage.sql.exec<{due: number | null}>(
      "SELECT MIN(next_recovery_at_ms) AS due FROM candidate_transactions WHERE phase NOT IN ('complete', 'aborted')",
    ).one().due;
    const terminal = this.storage.sql.exec<{due: number | null}>(
      "SELECT MIN(created_at_ms) AS due FROM candidate_transactions WHERE phase IN ('complete', 'aborted')",
    ).one().due;
    const deadlines = [pending, terminal === null ? null : terminal + TRANSACTION_IDEMPOTENCY_RETENTION_MS].filter((value): value is number => value !== null);
    if (!deadlines.length) return;
    const due = Math.max(Date.now() + 1_000, Math.min(...deadlines));
    const current = await this.storage.getAlarm();
    if (current === null || due < current) await this.storage.setAlarm(due);
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
          const response = await this.execute(graph.value, batch.value);
          await response.arrayBuffer();
        } catch (error) {
          console.error("transaction ledger recovery remains pending", row.tx_id, String(error));
        }
      }
    };
    try { await Promise.all(Array.from({length: RECOVERY_CONCURRENCY}, worker)); }
    finally { await this.schedule(); }
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
      }
    });
  }
}
