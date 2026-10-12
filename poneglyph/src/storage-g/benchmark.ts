import { GraphCoordinatorDO } from "./coordinator.js";
import { GraphShardDO } from "./shard.js";
import { auditFactStorage } from "../testing/storage-audit.js";
import { TREE_DEPTH, TREE_PREFIXES, LEDGER_BUCKETS, ledgerCoordinatorName, treeCoordinatorName, transactionCoordinatorName } from "./forest.js";
import { parseVirtualPrefix, shardObjectName } from "./keys.js";
import { isRecord } from "../domain/result.js";

export class BenchCoordinatorDO extends GraphCoordinatorDO {
  async transactionState(txId: string, graphId: string) {
    const response = await this.env.GRAPH_COORDINATORS.getByName(await transactionCoordinatorName(graphId, txId)).fetch(`https://transaction.internal/_transaction-audit?txId=${encodeURIComponent(txId)}`, {method: "POST"});
    if (!response.ok) throw new Error("transaction audit failed");
    return response.json();
  }
  async audit() {
    const graph = this.ctx.storage.sql.exec<{graph_id: string}>("SELECT graph_id FROM graph_identity").toArray()[0]?.graph_id;
    // Writes bypass the facade entirely. Bench env supplies the graph explicitly
    // for a fresh/read-only facade that has not acquired its first read cut.
    const graphId = graph ?? (this.env as typeof this.env & {GRAPH_ID: string}).GRAPH_ID;
    const trees = await Promise.all(TREE_PREFIXES.map(async prefix => {
      const response = await this.env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graphId, prefix)).fetch("https://tree.internal/_tree-audit", {
        method: "POST", body: JSON.stringify({ graphId, prefix }),
      });
      if (!response.ok) throw new Error("subtree audit failed");
      return { prefix, ...await response.json() as Record<string, unknown> } as Record<string, unknown>;
    }));
    const phases: {phase: string; count: number}[] = [];
    const ids = new Set<string>();
    for (const tree of trees) {
      if (Number(tree["entityLockCount"]) !== 0 || Number(tree["ownerTicketAnomalies"]) !== 0) throw new Error("unresolved/inconsistent owner entity tickets");
      for (const p of [...tree["phases"] as {phase: string; count: number}[], ...tree["reservations"] as {phase: string; count: number}[]]) phases.push(p);
      for (const row of tree["transactions"] as {tx_id: string}[]) ids.add(row.tx_id);
    }
    // Every admitted transaction referenced by an owner must have a terminal,
    // payload-bound per-transaction record too. No audit repairs state.
    for (const txId of ids) {
      const response = await this.env.GRAPH_COORDINATORS.getByName(await transactionCoordinatorName(graphId, txId)).fetch(`https://transaction.internal/_transaction-audit?txId=${encodeURIComponent(txId)}`, { method: "POST" });
      const rows = await response.json() as {phase: string}[];
      if (!response.ok || rows.length !== 1 || !["complete", "aborted"].includes(rows[0]!.phase)) throw new Error(`unresolved transaction coordinator ${txId}`);
    }
    const ledgers = await Promise.all(LEDGER_BUCKETS.map(async bucket => {
      const response = await this.env.GRAPH_COORDINATORS.getByName(ledgerCoordinatorName(graphId, bucket)).fetch("https://ledger.internal/_ledger-audit", {method: "POST"});
      if (!response.ok) throw new Error("ledger audit failed");
      const summary = await response.json() as {phases: {phase: string; count: number}[]; databaseBytes: number};
      for (const state of summary.phases) {
        if (!["complete", "aborted"].includes(state.phase)) throw new Error("unresolved pooled transaction intent");
      }
      return {bucket, ...summary};
    }));
    return { state: [{visible_seq: Math.max(...trees.map(t => Number(t["visible_seq"]))), writer_tx_id: null}], phases,
      visibilityScope: "subtree-vector", trees: trees.map(t => { const {transactions: _ids, ...summary} = t; return summary; }), checkedTransactionCoordinators: ids.size,
      ledgers, transactionCoordinatorStorageBytes: ledgers.reduce((n, l) => n + l.databaseBytes, 0),
      storageScope: "fact leaves, owner/facade metadata, and all sixteen transaction ledger databases",
      databaseBytes: trees.reduce((n, t) => n + Number(t["databaseBytes"]), this.ctx.storage.sql.databaseSize) + ledgers.reduce((n, l) => n + l.databaseBytes, 0) };
  }
}

export class BenchShardDO extends GraphShardDO {
  async audit(after: number, graphId?: string, inputPrefix?: string): Promise<Record<string, unknown>> {
    const parsed = parseVirtualPrefix(inputPrefix ?? "");
    if (!parsed.ok || !graphId) throw new Error("missing audit identity");
    const prefix = parsed.value;
    if (prefix.length < TREE_DEPTH) {
      const identity = [{ role: "router", prefix, child_zero_prefix: `${prefix}0`, child_one_prefix: `${prefix}1` }];
      if (prefix !== "") return { identity, facts: [] };
      // Aggregate counts for the unchanged scalar fixture checks, while retaining
      // true router identity. The full auditor still visits every real leaf.
      const pages = await Promise.all(TREE_PREFIXES.map(async tree => {
        const stub = this.env.GRAPH_SHARDS.getByName(shardObjectName(graphId, tree)) as DurableObjectStub<BenchShardDO>;
        return stub.audit(0, graphId, tree);
      }));
      const totals: Record<string, unknown> = {identity, facts: []};
      for (const key of ["active", "values", "missingValues", "orphanValues", "mismatchedValues", "mismatchedFacts", "mismatchedDatalog"])
        totals[key] = [{count: pages.reduce((n, p) => n + Number((p[key] as {count: number}[])[0]!.count), 0)}];
      return totals;
    }
    // A completely untouched range has no identity row yet; that is an empty
    // real leaf, not permission to ignore persisted facts in an initialized one.
    const identity = this.ctx.storage.sql.exec("SELECT * FROM shard_identity").toArray();
    const result = auditFactStorage(this.ctx.storage, after);
    const preparedGrowth = this.ctx.storage.sql.exec<{bytes: number}>("SELECT COALESCE(SUM(reserved_mutation_bytes), 0) AS bytes FROM shard_transactions WHERE status = 'prepared'").one().bytes;
    if (preparedGrowth !== 0) throw new Error("unresolved prepared mutation growth");
    const malformed = this.ctx.storage.sql.exec<{count: number}>(`SELECT COUNT(*) AS count FROM shard_transactions
      WHERE decision_kind = 'atomic' AND (status = 'prepared' OR payload_json IS NOT NULL
        OR atomic_commit_seq IS NULL OR atomic_commit_seq < 1 OR atomic_statement_ms IS NULL
        OR atomic_generation IS NULL OR atomic_directory_epoch IS NULL
        OR (status = 'committed' AND (atomic_fact_count IS NULL OR atomic_fact_count < 1 OR atomic_rejection_status IS NOT NULL))
        OR (status = 'cancelled' AND (atomic_fact_count != 0 OR atomic_rejection_status IS NULL)))`).one().count;
    if (malformed !== 0) throw new Error("invalid atomic decision representation");
    if (!identity.length || identity[0]?.["role"] === "leaf") {
      const incomplete = this.ctx.storage.sql.exec<{count: number}>(`SELECT COUNT(*) AS count FROM shard_transactions t
        WHERE t.decision_kind = 'atomic' AND t.status = 'committed' AND t.atomic_fact_count !=
          (SELECT COUNT(*) FROM fact_log f WHERE f.tx_id = t.tx_id AND f.commit_seq = t.atomic_commit_seq)`).one().count;
      if (incomplete !== 0) throw new Error("atomic committed decision lost complete local membership");
    }
    const atomicDecisions = this.ctx.storage.sql.exec("SELECT status, COUNT(*) AS count FROM shard_transactions WHERE decision_kind = 'atomic' GROUP BY status").toArray();
    if (!identity.length) result.identity = [{role: "leaf", prefix}];
    const response = await this.env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graphId, prefix.slice(0, TREE_DEPTH) as typeof prefix)).fetch("https://tree.internal/_tree-audit", {
      method: "POST", body: JSON.stringify({graphId, prefix: prefix.slice(0, TREE_DEPTH)}),
    });
    const state: unknown = await response.json();
    if (!response.ok || !isRecord(state)) throw new Error("invalid owner audit");
    const maximum = result.maxCommitSeq?.[0]?.["value"];
    if (typeof maximum === "number" && maximum > Number(state["visible_seq"])) throw new Error("leaf facts beyond their own subtree visibility");
    if (state["writer_tx_id"] !== null || state["topology_op_id"] !== null || Number(state["entityLockCount"]) !== 0 || Number(state["ownerTicketAnomalies"]) !== 0) throw new Error("unresolved subtree entity/topology fence");
    return {...result, preparedGrowthBytes: preparedGrowth, atomicDecisions};
  }
}
