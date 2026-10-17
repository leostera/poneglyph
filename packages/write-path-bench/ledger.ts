import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseFactBatch, type FactInput } from "@leostera/poneglyph";
import type { CallOutcome } from "./driver.js";

export function tupleHash(source: unknown, entity: unknown, field: unknown, value: unknown, retraction: unknown): string {
  return createHash("sha256").update(JSON.stringify([source, entity, field, value, Boolean(retraction)])).digest("hex");
}

export async function prepareReference(input: string, filename: string, limit: number) {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE facts (ordinal INTEGER PRIMARY KEY, tuple_hash TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO facts VALUES (?, ?)");
  const digest = createHash("sha256");
  let count = 0;
  db.exec("BEGIN");
  try {
    const lines = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
    for await (const line of lines) {
      const parsed = parseFactBatch({ txId: "bench:reference", facts: [JSON.parse(line)] });
      if (!parsed.ok) throw new Error(`invalid corpus fact ${count}: ${parsed.error.message}`);
      const fact = parsed.value.facts[0]!;
      insert.run(count++, tupleHash(fact.source, fact.entity, fact.field, fact.value, fact.retraction));
      digest.update(JSON.stringify(fact) + "\n");
      if (count >= limit) break;
      if (count % 10000 === 0) db.exec("COMMIT; BEGIN");
    }
    db.exec("COMMIT; CREATE INDEX facts_by_hash ON facts(tuple_hash, ordinal); PRAGMA wal_checkpoint(TRUNCATE)");
    if (count !== limit) throw new Error(`corpus contains ${count} facts, fewer than requested ${limit}`);
    return { facts: count, normalizedPrefixSha256: digest.digest("hex") };
  } finally { db.close(); }
}

export async function* corpusBatches(input: string, limit: number, batchSize: number, prefix: string) {
  const lines = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
  let count = 0, ordinal = 0, facts: FactInput[] = [];
  for await (const line of lines) {
    const parsed = parseFactBatch({ txId: "bench:stream", facts: [JSON.parse(line)] });
    if (!parsed.ok) throw new Error(`invalid corpus fact ${count}: ${parsed.error.message}`);
    facts.push(parsed.value.facts[0]!); count++;
    if (facts.length === batchSize || count === limit) {
      const txId = `${prefix}:${ordinal++}`;
      yield {txId, facts, body: JSON.stringify({clientRequestToken: txId, facts})};
      facts = [];
    }
    if (count === limit) break;
  }
  if (count !== limit) throw new Error(`corpus ended at ${count}, expected ${limit}`);
}

export class AuditLedger {
  readonly db: DatabaseSync;
  private writes = 0;
  constructor(filename: string, reference: string, readonly prefix: string, readonly factCount: number, readonly batchSize: number) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS outcomes (ordinal INTEGER PRIMARY KEY, kind TEXT NOT NULL, facts INTEGER NOT NULL, server_tx_id TEXT);
      CREATE TABLE IF NOT EXISTS matched (ordinal INTEGER PRIMARY KEY, tx_ordinal INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS matched_by_tx ON matched(tx_ordinal);`);
    this.db.prepare("ATTACH DATABASE ? AS reference").run(reference);
    this.db.exec("BEGIN");
  }
  transactionOrdinal(txId: string): number {
    if (!txId.startsWith(this.prefix + ":")) throw new Error(`unexpected transaction ${txId}`);
    const suffix = txId.slice(this.prefix.length + 1);
    if (!/^\d+$/.test(suffix)) throw new Error("invalid transaction ordinal");
    const ordinal = Number(suffix);
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal * this.batchSize >= this.factCount) throw new Error("transaction outside workload");
    return ordinal;
  }
  recordOutcome(outcome: CallOutcome) {
    this.db.prepare("INSERT INTO outcomes VALUES (?, ?, ?, ?)").run(this.transactionOrdinal(outcome.txId), outcome.kind, outcome.facts, outcome.serverTxId ?? null);
    if (++this.writes % 10000 === 0) this.db.exec("COMMIT; BEGIN");
  }
  beginAudit() { this.db.exec("COMMIT; DELETE FROM matched; BEGIN"); }
  matchFact(txId: string, hash: string) {
    const outcome = this.db.prepare("SELECT ordinal FROM outcomes WHERE server_tx_id = ?").get(txId);
    if (typeof outcome?.ordinal !== "number") throw new Error(`persisted fact has no acknowledged server transaction ID: ${txId}`);
    const tx = outcome.ordinal;
    const row = this.db.prepare(`SELECT ordinal FROM reference.facts f WHERE tuple_hash = ? AND ordinal >= ? AND ordinal < ?
      AND NOT EXISTS (SELECT 1 FROM matched m WHERE m.ordinal = f.ordinal) ORDER BY ordinal LIMIT 1`)
      .get(hash, tx * this.batchSize, Math.min((tx + 1) * this.batchSize, this.factCount));
    if (typeof row?.ordinal !== "number") throw new Error(`extra or mismatched persisted fact in ${txId}`);
    this.db.prepare("INSERT INTO matched VALUES (?, ?)").run(row.ordinal, tx);
    if (++this.writes % 10000 === 0) this.db.exec("COMMIT; BEGIN");
  }
  finishAudit() {
    const partial = this.db.prepare(`SELECT tx_ordinal, COUNT(*) AS count FROM matched GROUP BY tx_ordinal
      HAVING count != MIN(?, ? - tx_ordinal * ?)` ).all(this.batchSize, this.factCount, this.batchSize);
    if (partial.length) throw new Error("partially persisted transaction");
    const missingAck = this.db.prepare(`SELECT ordinal FROM outcomes o WHERE kind = 'committed' AND
      (SELECT COUNT(*) FROM matched m WHERE m.tx_ordinal = o.ordinal) != o.facts LIMIT 1`).get();
    if (missingAck) throw new Error("acknowledged transaction missing from persistent storage");
    const persistedRejected = this.db.prepare(`SELECT ordinal FROM outcomes o WHERE kind = 'rejected' AND
      EXISTS (SELECT 1 FROM matched m WHERE m.tx_ordinal = o.ordinal) LIMIT 1`).get();
    if (persistedRejected) throw new Error("rejected transaction persisted");
    const totals = this.db.prepare("SELECT COUNT(*) AS facts, COUNT(DISTINCT tx_ordinal) AS transactions FROM matched").get()!;
    const active = this.db.prepare("SELECT COUNT(DISTINCT f.tuple_hash) AS count FROM reference.facts f JOIN matched m ON m.ordinal = f.ordinal").get()!;
    const unknown = this.db.prepare(`SELECT COUNT(*) AS count FROM outcomes o WHERE kind = 'unknown' AND
      EXISTS (SELECT 1 FROM matched m WHERE m.tx_ordinal = o.ordinal)`).get()!;
    this.db.exec("COMMIT; BEGIN");
    return { persistedFacts: Number(totals.facts), persistedTransactions: Number(totals.transactions), activeTuples: Number(active.count),
      reconciledUnacknowledgedTransactions: Number(unknown.count), allFactsPersisted: Number(totals.facts) === this.factCount };
  }
  close() { this.db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)"); this.db.close(); }
}
