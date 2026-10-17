import { DurableObject } from "cloudflare:workers";
import { ClientRequestTokenCoordinator } from "./request-tokens.js";
import type { StorageEnv } from "./environment.js";
import { TransactionLedger } from "./ledger.js";
import { jsonResponse } from "./http.js";
import { ensureLedgerSchema } from "./sql.js";

type LedgerEnv = Env & StorageEnv;

/** One actor owns a ledger bucket, its token-to-transaction map, and their shared alarm. */
export class GraphLedgerDO extends DurableObject<LedgerEnv> {
  private readonly ledger: TransactionLedger;
  private readonly requestTokens: ClientRequestTokenCoordinator;
  private alarmUpdate: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: LedgerEnv) {
    super(ctx, env);
    this.ledger = new TransactionLedger(ctx.storage, env, () => this.scheduleAlarm());
    this.requestTokens = new ClientRequestTokenCoordinator(ctx.storage, this.ledger, () => this.scheduleAlarm());
    void ctx.blockConcurrencyWhile(async () => ensureLedgerSchema(ctx.storage));
  }

  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/_transact") return this.ledger.fetch(request);
    if (request.method === "POST" && pathname === "/_request") return this.requestTokens.fetch(request);
    if (request.method === "POST" && pathname === "/_transaction-status") return this.ledger.status(request);
    if (request.method === "POST" && pathname === "/_transaction-audit") {
      const txId = new URL(request.url).searchParams.get("txId");
      return jsonResponse(this.ctx.storage.sql.exec(
        "SELECT tx_id, phase, payload_hash FROM candidate_transactions WHERE tx_id = ?", txId,
      ).toArray());
    }
    if (request.method === "POST" && pathname === "/_ledger-audit") return jsonResponse({
      context: this.ctx.storage.sql.exec("SELECT * FROM ledger_context").toArray(),
      phases: this.ctx.storage.sql.exec("SELECT phase, COUNT(*) AS count FROM candidate_transactions GROUP BY phase").toArray(),
      requestTokens: this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM client_request_tokens").toArray(),
      databaseBytes: this.ctx.storage.sql.databaseSize,
    });
    return jsonResponse({ error: "not found" }, 404);
  }

  override async alarm(): Promise<void> {
    await Promise.all([this.ledger.alarm(), this.requestTokens.alarm()]);
    await this.scheduleAlarm();
  }

  private scheduleAlarm(): Promise<void> {
    const update = this.alarmUpdate.then(() => this.updateAlarm());
    this.alarmUpdate = update.catch(() => undefined);
    return update;
  }

  private async updateAlarm(): Promise<void> {
    const [ledgerDeadline, tokenDeadline] = await Promise.all([
      this.ledger.nextMaintenanceAt(),
      this.requestTokens.nextMaintenanceAt(),
    ]);
    const deadlines = [ledgerDeadline, tokenDeadline].filter((value): value is number => value !== undefined);
    if (deadlines.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const due = Math.max(Date.now() + 1_000, Math.min(...deadlines));
    const current = await this.ctx.storage.getAlarm();
    if (current === null || due < current) await this.ctx.storage.setAlarm(due);
  }
}
