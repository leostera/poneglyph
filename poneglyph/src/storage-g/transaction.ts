import { parseFactBatch, type FactBatch } from "../domain/fact.js";
import { parseGraphId } from "../domain/graph-id.js";
import { isRecord } from "../domain/result.js";
import { MAX_TRANSACTION_BYTES, MAX_TRANSACTION_FACTS, MAX_TRANSACTION_PARTICIPANTS, TRANSACTION_IDEMPOTENCY_RETENTION_MS } from "./constants.js";
import { accountStorage } from "./capacity.js";
import { canonicalBatchJson, jsonResponse, readJsonBody, sha256Hex } from "./http.js";
import { treeForKey, treeCoordinatorName } from "./forest.js";
import { virtualKeyForEntity, shardObjectName, type VirtualPrefix, type VirtualKey } from "./keys.js";
import { resolveEntityLeaf, type LeafAddress } from "./routing.js";
import { factAsJson } from "./protocol.js";
import type { CandidateStorageEnv } from "./environment.js";

type Phase = "preparing" | "committing" | "cancelling" | "complete" | "aborted";
type Intent = Readonly<{ tx_id: string; graph_id: string; payload_hash: string; batch_json: string;
  trees_json: string; plan_json: string | null; phase: Phase; commit_seq: number; statement_time_ms: number; created_at_ms: number }>;
type TreeLock = Readonly<{ prefix: VirtualPrefix; visibleSeq: number; directoryEpoch: number }>;
type Participant = Readonly<{ address: LeafAddress; directoryEpoch: number;
  facts: readonly Readonly<{index: number; virtualKey: VirtualKey; fact: FactBatch["facts"][number]}>[] }>;

export class DistributedTransaction {
  private active = false;
  constructor(private readonly storage: DurableObjectStorage, private readonly env: CandidateStorageEnv) {}

  async fetch(request: Request): Promise<Response> {
    const raw = await readJsonBody(request, MAX_TRANSACTION_BYTES + 256);
    if (!raw.ok || !isRecord(raw.value)) return jsonResponse({ error: "invalid transaction envelope" }, 400);
    const graph = parseGraphId(raw.value["graphId"]), batch = parseFactBatch(raw.value["batch"]);
    if (!graph.ok || !batch.ok) return jsonResponse({ error: "invalid graph or fact batch" }, 400);
    const json = canonicalBatchJson(batch.value);
    if (batch.value.facts.length > MAX_TRANSACTION_FACTS || new TextEncoder().encode(json).byteLength > MAX_TRANSACTION_BYTES)
      return jsonResponse({ error: "transaction exceeds fact/byte limit", retryable: false }, 413);
    const hash = await sha256Hex(json);
    let prior = this.read();
    if (prior && prior.tx_id !== batch.value.txId) return jsonResponse({ error: "transaction object identity conflict" }, 409);
    if (prior && (prior.phase === "complete" || prior.phase === "aborted") &&
        prior.created_at_ms < Date.now() - TRANSACTION_IDEMPOTENCY_RETENTION_MS) {
      this.storage.sql.exec("DELETE FROM candidate_transactions"); prior = undefined;
    }
    if (prior && (prior.graph_id !== graph.value || prior.payload_hash !== hash))
      return jsonResponse({ error: "txId has already been used with a different fact batch" }, 409);
    if (prior?.phase === "complete") return this.receipt(prior);
    if (prior?.phase === "aborted") return jsonResponse({ txId: prior.tx_id, status: "aborted", retryable: false }, 422);
    if (this.active) return jsonResponse({ error: "this transaction is active", retryable: true }, 423);
    this.active = true;
    try {
      if (!prior) {
        const trees = [...new Set(await Promise.all(batch.value.facts.map(async f => treeForKey(await virtualKeyForEntity(graph.value, f.entity)))))].sort();
        const capacity = accountStorage(this.storage.sql.databaseSize, { factLogBytes: 0, activeIndexBytes: 0,
          projectionBytes: 0, transactionStagingBytes: new TextEncoder().encode(json).byteLength * 3 + 4096 });
        if (!capacity.canAdmit) return jsonResponse({ error: "transaction metadata capacity exceeded", retryable: false }, 413);
        this.storage.sql.exec(`INSERT INTO candidate_transactions
          (tx_id, graph_id, payload_hash, batch_json, trees_json, phase, commit_seq, statement_time_ms, created_at_ms)
          VALUES (?, ?, ?, ?, ?, 'preparing', 0, 0, ?)`, batch.value.txId, graph.value, hash, json, JSON.stringify(trees), Date.now());
      }
      return await this.advance();
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error), txId: batch.value.txId, retryable: true }, 503);
    } finally { this.active = false; }
  }

  private read(): Intent | undefined {
    return this.storage.sql.exec<Intent>("SELECT * FROM candidate_transactions").toArray()[0];
  }
  private receipt(intent: Intent): Response {
    return jsonResponse({ txId: intent.tx_id, commitSeq: intent.commit_seq, status: "committed", sequenceScope: "subtree" });
  }
  private async tree(intent: Intent, prefix: VirtualPrefix, action: string, extra: object = {}): Promise<Response> {
    return this.env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(intent.graph_id, prefix)).fetch(`https://tree.internal/${action}`, {
      method: "POST", body: JSON.stringify({ graphId: intent.graph_id, prefix, txId: intent.tx_id, payloadHash: intent.payload_hash, ...extra }),
    });
  }
  private async advance(): Promise<Response> {
    let intent = this.read()!;
    const trees = JSON.parse(intent.trees_json) as VirtualPrefix[];
    const batch = parseFactBatch(JSON.parse(intent.batch_json));
    if (!batch.ok) throw new Error("corrupt durable transaction batch");
    // One-tree writes still use the duplicated, tested local coordinator protocol.
    // Identity is always bound here first, so a changed payload cannot escape to another tree.
    if (trees.length === 1 && intent.phase === "preparing") {
      const response = await this.tree(intent, trees[0]!, "_tree-transaction", { batch: batch.value });
      const body = await response.clone().json() as Record<string, unknown>;
      if (response.ok) {
        if (typeof body["commitSeq"] !== "number") throw new Error("invalid tree receipt");
        this.storage.sql.exec("UPDATE candidate_transactions SET phase = 'complete', commit_seq = ?", body["commitSeq"]);
        return this.receipt(this.read()!);
      }
      if (response.status === 422) this.storage.sql.exec("UPDATE candidate_transactions SET phase = 'aborted'");
      else if (response.status === 423 || response.status === 429 || response.status === 413) this.storage.sql.exec("DELETE FROM candidate_transactions");
      return response;
    }

    if (intent.phase === "preparing") {
      const locks: TreeLock[] = [];
      // Deterministic lock order and release on contention: no blocking deadlock.
      for (const prefix of trees) {
        const response = await this.tree(intent, prefix, "_tree-lock");
        if (!response.ok) {
          if (intent.plan_json !== null) throw new Error("a persisted prepare plan lost its subtree gate");
          await this.releaseLocks(intent, trees);
          this.storage.sql.exec("DELETE FROM candidate_transactions");
          return response;
        }
        const value = await response.json() as Record<string, unknown>;
        if (typeof value["visibleSeq"] !== "number" || typeof value["directoryEpoch"] !== "number") throw new Error("invalid tree lock");
        locks.push({ prefix, visibleSeq: value["visibleSeq"], directoryEpoch: value["directoryEpoch"] });
      }
      let plan: Participant[];
      if (intent.plan_json !== null) {
        plan = JSON.parse(intent.plan_json) as Participant[];
      } else {
        const groups = new Map<string, {address: LeafAddress; directoryEpoch: number; facts: Participant["facts"][number][]}>();
        for (const [index, fact] of batch.value.facts.entries()) {
          const virtualKey = await virtualKeyForEntity(intent.graph_id, fact.entity);
          const lock = locks.find(x => x.prefix === treeForKey(virtualKey))!;
          const graph = parseGraphId(intent.graph_id); if (!graph.ok) throw new Error("corrupt graph identity");
          const address = (await resolveEntityLeaf(this.env, graph.value, fact.entity, lock.directoryEpoch)).address;
          const group = groups.get(address.prefix) ?? { address, directoryEpoch: lock.directoryEpoch, facts: [] };
          group.facts.push({ index, fact: factAsJson(fact), virtualKey }); groups.set(address.prefix, group);
        }
        plan = [...groups.values()];
        if (plan.length > MAX_TRANSACTION_PARTICIPANTS) {
          this.storage.sql.exec("UPDATE candidate_transactions SET phase = 'cancelling', plan_json = '[]'");
          await this.cancel(this.read()!, trees, []);
          return jsonResponse({ error: "participant limit exceeded", retryable: false }, 413);
        }
        const seq = Math.max(...locks.map(x => x.visibleSeq)) + 1;
        this.storage.sql.exec("UPDATE candidate_transactions SET plan_json = ?, commit_seq = ?, statement_time_ms = ?",
          JSON.stringify(plan), seq, Date.now());
        intent = this.read()!;
      }
      // Preflight is read-only. Permanent rejections cancel before an intent is prepared on any leaf.
      const preflight = await Promise.all(plan.map(p => this.participant(intent, p, "_preflight")));
      const permanent = preflight.find(r => r.status >= 400 && r.status < 500);
      const capacity = await Promise.all(preflight.filter(r => r.ok).map(r => r.json() as Promise<{canAdmit?: boolean; shouldSplit?: boolean}>));
      if (permanent || capacity.some(x => x.canAdmit !== true || x.shouldSplit === true)) {
        this.storage.sql.exec("UPDATE candidate_transactions SET phase = 'cancelling'");
        await this.cancel(this.read()!, trees, plan);
        return permanent ?? jsonResponse({ error: "cross-tree capacity preflight rejected", retryable: false }, 413);
      }
      if (preflight.some(r => !r.ok)) throw new Error("participant preflight incomplete");
      const prepares = await Promise.all(plan.map(p => this.participant(intent, p, "_prepare")));
      if (prepares.some(r => r.status >= 400 && r.status < 500)) {
        this.storage.sql.exec("UPDATE candidate_transactions SET phase = 'cancelling'");
        await this.cancel(this.read()!, trees, plan);
        return jsonResponse({ txId: intent.tx_id, status: "aborted", retryable: false }, 422);
      }
      if (prepares.some(r => !r.ok)) throw new Error("participant prepare incomplete");
      // This is the irrevocable decision. Gates remain owned until every apply finishes.
      this.storage.sql.exec("UPDATE candidate_transactions SET phase = 'committing' WHERE phase = 'preparing'");
      intent = this.read()!;
    }
    const plan = JSON.parse(intent.plan_json!) as Participant[];
    if (intent.phase === "cancelling") {
      await this.cancel(intent, trees, plan);
      return jsonResponse({ txId: intent.tx_id, status: "aborted", retryable: false }, 422);
    }
    if (intent.phase === "committing") {
      const responses = await Promise.all(plan.map(p => this.participant(intent, p, "_commit")));
      if (responses.some(r => !r.ok)) throw new Error("irrevocable commit apply incomplete");
      // Keep committing until all owner publications are acknowledged, so a lost
      // response retries publication rather than returning early from complete.
      for (const prefix of trees) {
        const response = await this.tree(intent, prefix, "_tree-finish", { commitSeq: intent.commit_seq });
        if (!response.ok) throw new Error("tree publication incomplete");
      }
      this.storage.sql.exec("UPDATE candidate_transactions SET phase = 'complete'");
    }
    return this.receipt(this.read()!);
  }
  private async participant(intent: Intent, participant: Participant, action: string): Promise<Response> {
    const response = await this.env.GRAPH_SHARDS.getByName(shardObjectName(intent.graph_id, participant.address.prefix)).fetch(`https://shard.internal/${action}`, {
      method: "POST", body: JSON.stringify({ graphId: intent.graph_id, shardPrefix: participant.address.prefix,
        shardGeneration: participant.address.generation, directoryEpoch: participant.directoryEpoch, txId: intent.tx_id,
        payloadHash: intent.payload_hash, commitSeq: intent.commit_seq, statementTimeMs: intent.statement_time_ms,
        ...(action === "_prepare" || action === "_preflight" ? {facts: participant.facts} : {}) }),
    });
    // Consume non-success bodies before retry; success JSON is small and returned to caller.
    return response;
  }
  private async releaseLocks(intent: Intent, trees: VirtualPrefix[], abort = false): Promise<void> {
    for (const prefix of trees) {
      const response = await this.tree(intent, prefix, "_tree-unlock", { abort });
      if (!response.ok) throw new Error("tree lock release incomplete");
    }
  }
  private async cancel(intent: Intent, trees: VirtualPrefix[], plan: Participant[]): Promise<void> {
    for (const p of plan) {
      const response = await this.participant(intent, p, "_cancel");
      if (!response.ok) throw new Error("cancellation incomplete");
    }
    await this.releaseLocks(intent, trees, true);
    this.storage.sql.exec("UPDATE candidate_transactions SET phase = 'aborted'");
  }
}
