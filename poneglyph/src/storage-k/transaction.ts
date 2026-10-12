import { parseFactBatch, type FactBatch } from "../domain/fact.js";
import type { GraphId } from "../domain/graph-id.js";
import { isRecord } from "../domain/result.js";
import { MAX_TRANSACTION_BYTES, MAX_TRANSACTION_FACTS, MAX_TRANSACTION_PARTICIPANTS, TRANSACTION_IDEMPOTENCY_RETENTION_MS } from "./constants.js";
import { accountStorage } from "./capacity.js";
import { canonicalBatchJson, jsonResponse, sha256Hex } from "./http.js";
import { LEDGER_OUTCOME_LIMIT, LEDGER_RECOVERY_DELAY_MS, treeCoordinatorName } from "./forest.js";
import { shardObjectName } from "./keys.js";
import { factAsJson } from "./protocol.js";
import { integer, planBatch, parseWritePlan, type WritePlan, type OwnerPlan, type ParticipantPlan } from "./plan.js";
import type { CandidateStorageEnv } from "./environment.js";
import type { BatchCache } from "./batch-cache.js";

type Phase = "planning" | "reserving" | "preparing" | "committing" | "atomic-delegated" | "cancelling" | "complete" | "aborted";
type Intent = Readonly<{tx_id: string; graph_id: string; payload_hash: string; batch_json: string; trees_json: string;
  plan_json: string | null; phase: Phase; commit_seq: number; statement_time_ms: number; created_at_ms: number; local_witness_json: string | null; participant_witness: number}>;
type LocalWitness = Readonly<{status: "committed" | "aborted"; txId: string; graphId: string; payloadHash: string;
  commitSeq: number; statementTimeMs: number; identityTimeMs: number; shardPrefix: string; shardGeneration: number; directoryEpoch: number; factCount: number}>;

export class DistributedTransaction {
  private active = false;
  constructor(private readonly storage: DurableObjectStorage, private readonly env: CandidateStorageEnv,
    private readonly txId: string, private readonly scheduleRecovery: () => Promise<void>, private readonly cache: BatchCache) {}

  async execute(graph: GraphId, batch: FactBatch, recovery = false): Promise<Response> {
    if (batch.txId !== this.txId) return jsonResponse({error: "transaction execution identity conflict"}, 409);
    const json = canonicalBatchJson(batch);
    if (batch.facts.length > MAX_TRANSACTION_FACTS || new TextEncoder().encode(json).byteLength > MAX_TRANSACTION_BYTES)
      return jsonResponse({error: "transaction exceeds fact/byte limit", retryable: false}, 413);
    const hash = await sha256Hex(json);
    let prior = this.read();
    if (prior && (prior.phase === "complete" || prior.phase === "aborted") && prior.created_at_ms < Date.now() - TRANSACTION_IDEMPOTENCY_RETENTION_MS) {
      this.storage.sql.exec("DELETE FROM candidate_transactions WHERE tx_id = ?", this.txId); this.cache.delete(this.txId); prior = undefined;
    }
    if (prior && (prior.graph_id !== graph || prior.payload_hash !== hash)) return jsonResponse({error: "txId has already been used with a different fact batch"}, 409);
    if (prior?.phase === "complete") return this.receipt(prior);
    if (prior?.phase === "aborted") return this.aborted(prior);
    if (this.active) return jsonResponse({error: "this transaction is active", retryable: true}, 423);
    this.active = true;
    try {
      if (!prior) {
        if (recovery) throw new Error("recovery cannot supply a new application transaction");
        const count = this.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM candidate_transactions").one().count;
        if (count >= LEDGER_OUTCOME_LIMIT) return jsonResponse({error: "transaction ledger reached its retained-outcome allocation", retryable: false}, 429);
        const capacity = accountStorage(this.storage.sql.databaseSize, {factLogBytes: 0, activeIndexBytes: 0, projectionBytes: 0,
          transactionStagingBytes: new TextEncoder().encode(json).byteLength * 3 + 4096});
        if (!capacity.canAdmit) return jsonResponse({error: "transaction metadata capacity exceeded", retryable: false}, 413);
        const now = Date.now();
        this.storage.sql.exec(`INSERT INTO candidate_transactions
          (tx_id, graph_id, payload_hash, batch_json, trees_json, phase, commit_seq, statement_time_ms, created_at_ms, next_recovery_at_ms)
          VALUES (?, ?, ?, ?, '[]', 'planning', 0, 0, ?, ?)`, this.txId, graph, hash, json, now, now + LEDGER_RECOVERY_DELAY_MS);
      }
      this.cache.put(this.txId, json, batch);
      await this.scheduleRecovery();
      return await this.advance(recovery);
    } catch (error) {
      return jsonResponse({error: error instanceof Error ? error.message : String(error), txId: this.txId, retryable: true}, 503);
    } finally {
      this.active = false;
      const phase = this.read()?.phase;
      if (!phase || phase === "complete" || phase === "aborted") this.cache.delete(this.txId);
    }
  }

  private read(): Intent | undefined { return this.storage.sql.exec<Intent>("SELECT * FROM candidate_transactions WHERE tx_id = ?", this.txId).toArray()[0]; }
  private phase(phase: Phase): Intent {
    this.storage.sql.exec("UPDATE candidate_transactions SET phase = ? WHERE tx_id = ?", phase, this.txId); return this.read()!;
  }
  private receipt(intent: Intent): Response {return jsonResponse({txId: this.txId, status: "committed", commitSeq: intent.commit_seq, sequenceScope: "subtree-vector"});}
  private aborted(intent: Intent): Response {return jsonResponse({txId: intent.tx_id, status: "aborted", retryable: false}, 422);}
  private async batch(intent: Intent): Promise<FactBatch> {
    const cached = this.cache.get(this.txId, intent.batch_json); if (cached) return cached;
    const parsed = parseFactBatch(JSON.parse(intent.batch_json));
    if (!parsed.ok || parsed.value.txId !== this.txId || await sha256Hex(canonicalBatchJson(parsed.value)) !== intent.payload_hash) throw new Error("corrupt durable canonical journal");
    this.cache.put(this.txId, intent.batch_json, parsed.value); return parsed.value;
  }
  private async tree(intent: Intent, owner: Pick<OwnerPlan, "prefix">, action: string, extra: object = {}): Promise<Response> {
    return this.env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(intent.graph_id, owner.prefix)).fetch(`https://owner.internal/${action}`, {
      method: "POST", body: JSON.stringify({graphId: intent.graph_id, prefix: owner.prefix, txId: this.txId, payloadHash: intent.payload_hash,
        identityTimeMs: intent.created_at_ms, ...extra}),
    });
  }
  private async participant(intent: Intent, plan: WritePlan, participant: ParticipantPlan, batch: FactBatch, action: string): Promise<Response> {
    const owner = plan.owners.find(o => o.prefix === participant.owner)!;
    return this.env.GRAPH_SHARDS.getByName(shardObjectName(intent.graph_id, participant.address.prefix)).fetch(`https://shard.internal/${action}`, {
      method: "POST", body: JSON.stringify({graphId: intent.graph_id, shardPrefix: participant.address.prefix,
        shardGeneration: participant.address.generation, directoryEpoch: owner.directoryEpoch, txId: this.txId, payloadHash: intent.payload_hash,
        commitSeq: owner.commitSeq || 1, statementTimeMs: intent.statement_time_ms, identityTimeMs: intent.created_at_ms,
        ...(action === "_preflight" || action === "_prepare" || action === "_atomic" ? {facts: participant.entries.map(entry =>
          ({...entry, fact: factAsJson(batch.facts[entry.index]!)}))} : {})}),
    });
  }
  private async preflight(intent: Intent, plan: WritePlan, batch: FactBatch): Promise<boolean> {
    const replies = await Promise.all(plan.participants.map(p => this.participant(intent, plan, p, batch, "_preflight")));
    let rejected = false;
    for (const response of replies) {
      const body: unknown = await response.json();
      if (!response.ok) {if (response.status >= 500) throw new Error("provisional capacity preflight unavailable"); rejected = true;}
      else if (!isRecord(body) || body["canAdmit"] !== true || body["shouldSplit"] === true) rejected = true;
    }
    return rejected;
  }

  private async advance(recovery: boolean): Promise<Response> {
    let intent = this.read()!;
    if (recovery && intent.phase === "planning") return this.aborted(this.phase("aborted"));
    const batch = await this.batch(intent);
    let plan: WritePlan;
    let freshlyReserved = false;
    if (intent.phase === "planning") {
      plan = await planBatch(this.env, intent.graph_id, batch, async prefix => {
        const response = await this.tree(intent, {prefix}, "_tree-directory");
        const value: unknown = await response.json();
        if (!response.ok || !isRecord(value)) throw new Error("provisional owner directory unavailable");
        return {directoryEpoch: integer(value["directoryEpoch"]), visibleSeq: integer(value["visibleSeq"])};
      });
      if (plan.participants.length > MAX_TRANSACTION_PARTICIPANTS) {
        this.storage.sql.exec("DELETE FROM candidate_transactions WHERE tx_id = ?", this.txId);
        return jsonResponse({error: "participant limit exceeded", retryable: false}, 413);
      }
      const rejected = await this.preflight(intent, plan, batch);
      // Persist exact possible ownership before the first reservation RPC.
      this.storage.sql.exec("UPDATE candidate_transactions SET phase = 'reserving', plan_json = ?, trees_json = ? WHERE tx_id = ?",
        JSON.stringify(plan), JSON.stringify(plan.owners.map(o => o.prefix)), this.txId);
      intent = this.read()!;
      const owners: OwnerPlan[] = [];
      for (const owner of plan.owners) {
        const response = await this.tree(intent, owner, "_tree-lock", {entities: owner.entities, directoryEpoch: owner.directoryEpoch});
        const value: unknown = await response.json();
        if (!response.ok) {
          await this.release(intent, plan, false);
          this.storage.sql.exec("DELETE FROM candidate_transactions WHERE tx_id = ?", this.txId);
          return jsonResponse(isRecord(value) ? value : {error: "owner reservation rejected", retryable: true}, response.status);
        }
        if (!isRecord(value) || integer(value["directoryEpoch"]) !== owner.directoryEpoch) throw new Error("provisional owner epoch changed");
        owners.push({...owner, commitSeq: integer(value["commitSeq"], 1)});
      }
      plan = {...plan, owners};
      this.storage.sql.exec(`UPDATE candidate_transactions SET phase = 'preparing', plan_json = ?, commit_seq = ?, statement_time_ms = ? WHERE tx_id = ?`,
        JSON.stringify(plan), Math.max(...owners.map(o => o.commitSeq)), Date.now(), this.txId);
      intent = this.read()!;
      freshlyReserved = true;
      // A provisional rejection is not authoritative after visibility changed.
      // Positive preflight never replaces actual prepare/atomic admission.
      if (rejected && await this.preflight(intent, plan, batch)) {
        await this.cancel(this.phase("cancelling"), plan, batch); return this.aborted(this.read()!);
      }
    } else {
      if (!intent.plan_json) throw new Error("admitted operation lost its exact plan");
      plan = await parseWritePlan(intent.plan_json, intent.graph_id, batch, intent.phase !== "reserving");
    }
    if (intent.phase === "reserving") {
      // Recover uncertain ownership only; no new reservation/admission on alarm.
      await this.release(intent, plan, true); return this.aborted(this.phase("aborted"));
    }
    if (intent.phase === "preparing") {
      // Fresh reservations already validated the tuple and now prevent lease,
      // split and overlapping writers until this driver finishes. Recovery
      // revalidates those durable fences without regrouping/rerouting the plan.
      if (!freshlyReserved) for (const owner of plan.owners) {
        const response = await this.tree(intent, owner, "_tree-lock", {entities: owner.entities, directoryEpoch: owner.directoryEpoch});
        const value: unknown = await response.json();
        if (!response.ok || !isRecord(value) || value["commitSeq"] !== owner.commitSeq || value["directoryEpoch"] !== owner.directoryEpoch)
          throw new Error("admitted prepare lost its exact owner reservation");
      }
      if (plan.participants.length === 1) intent = this.phase("atomic-delegated");
      else {
        const replies = await Promise.all(plan.participants.map(p => this.participant(intent, plan, p, batch, "_prepare")));
        const permanent = replies.some(r => r.status >= 400 && r.status < 500), incomplete = replies.some(r => !r.ok);
        await Promise.all(replies.map(r => r.arrayBuffer()));
        if (permanent) {await this.cancel(this.phase("cancelling"), plan, batch); return this.aborted(this.read()!);}
        if (incomplete) throw new Error("participant prepare incomplete");
        intent = this.phase("committing");
      }
    }
    if (intent.phase === "atomic-delegated") return this.finishAtomic(intent, plan, batch);
    if (intent.phase === "cancelling") {await this.cancel(intent, plan, batch); return this.aborted(this.read()!);}
    if (intent.phase !== "committing") throw new Error("unsupported durable transaction phase");
    if (intent.participant_witness !== 1) {
      const replies = await Promise.all(plan.participants.map(p => this.participant(intent, plan, p, batch, "_commit")));
      const incomplete = replies.some(r => !r.ok); await Promise.all(replies.map(r => r.arrayBuffer()));
      if (incomplete) throw new Error("irrevocable commit apply incomplete");
      this.storage.sql.exec("UPDATE candidate_transactions SET participant_witness = 1 WHERE tx_id = ?", this.txId);
    }
    await this.publish(intent, plan);
    const terminal = this.phase("complete");
    await this.finalize(intent, plan, batch);
    return this.receipt(terminal);
  }

  private witness(value: unknown, intent: Intent, plan: WritePlan, batch: FactBatch): LocalWitness {
    if (!isRecord(value) || value["status"] !== "committed" && value["status"] !== "aborted") throw new Error("invalid local decision witness");
    const participant = plan.participants[0]!, owner = plan.owners[0]!;
    const expected = {txId: this.txId, graphId: intent.graph_id, payloadHash: intent.payload_hash,
      commitSeq: owner.commitSeq, statementTimeMs: intent.statement_time_ms, identityTimeMs: intent.created_at_ms,
      shardPrefix: participant.address.prefix, shardGeneration: participant.address.generation, directoryEpoch: owner.directoryEpoch,
      factCount: value["status"] === "committed" ? batch.facts.length : 0};
    for (const [key, field] of Object.entries(expected)) if (value[key] !== field) throw new Error("local decision witness changed its authority tuple");
    return {...expected, status: value["status"]};
  }
  private async finishAtomic(intent: Intent, plan: WritePlan, batch: FactBatch): Promise<Response> {
    if (plan.participants.length !== 1 || plan.owners.length !== 1) throw new Error("delegation changed physical authority");
    const participant = plan.participants[0]!;
    let witness: LocalWitness;
    if (intent.local_witness_json) witness = this.witness(JSON.parse(intent.local_witness_json), intent, plan, batch);
    else {
      const response = await this.participant(intent, plan, participant, batch, "_atomic");
      const value: unknown = await response.json();
      if (!response.ok) throw new Error("local decision authority returned no terminal answer");
      witness = this.witness(value, intent, plan, batch);
      // This witness must precede releasing topology/conflict fences. Recovery
      // must not require re-mutating a leaf that can now have become a router.
      this.storage.sql.exec("UPDATE candidate_transactions SET local_witness_json = ? WHERE tx_id = ?", JSON.stringify(witness), this.txId);
    }
    if (witness.status === "committed") await this.publish(intent, plan);
    else await this.release(intent, plan, true);
    const terminal = this.phase(witness.status === "committed" ? "complete" : "aborted");
    await this.finalize(intent, plan, batch);
    return witness.status === "committed" ? this.receipt(terminal) : this.aborted(terminal);
  }
  private async finalize(intent: Intent, plan: WritePlan, batch: FactBatch): Promise<void> {
    await Promise.all(plan.participants.map(async participant => {
      try {
        const response = await this.participant(intent, plan, participant, batch, "_decision-finalize");
        const ok = response.ok; await response.arrayBuffer();
        if (!ok) throw new Error(`finalization status ${response.status}`);
      } catch (error) {console.warn("participant outcome finalization deferred", String(error));}
    }));
  }
  private async publish(intent: Intent, plan: WritePlan): Promise<void> {
    for (const owner of plan.owners) {
      const response = await this.tree(intent, owner, "_tree-finish", {commitSeq: owner.commitSeq});
      const ok = response.ok; await response.arrayBuffer(); if (!ok) throw new Error("owner publication incomplete");
    }
  }
  private async release(intent: Intent, plan: WritePlan, abort: boolean): Promise<void> {
    for (const owner of plan.owners) {
      const response = await this.tree(intent, owner, "_tree-unlock", {abort});
      const ok = response.ok; await response.arrayBuffer(); if (!ok) throw new Error("owner release incomplete");
    }
  }
  private async cancel(intent: Intent, plan: WritePlan, batch: FactBatch): Promise<void> {
    if (intent.participant_witness !== 1) {
      for (const participant of plan.participants) {
        const response = await this.participant(intent, plan, participant, batch, "_cancel");
        const ok = response.ok; await response.arrayBuffer(); if (!ok) throw new Error("participant cancellation incomplete");
      }
      this.storage.sql.exec("UPDATE candidate_transactions SET participant_witness = 1 WHERE tx_id = ?", this.txId);
    }
    await this.release(intent, plan, true); this.phase("aborted");
    await this.finalize(intent, plan, batch);
  }
}
