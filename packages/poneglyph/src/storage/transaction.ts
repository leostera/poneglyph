import { parseFactBatch, type FactBatch } from "../domain/fact.js";
import type { GraphId } from "../domain/graph-id.js";
import { isRecord } from "../domain/result.js";
import { MAX_TRANSACTION_BYTES, MAX_TRANSACTION_FACTS, MAX_TRANSACTION_PARTICIPANTS, TRANSACTION_IDEMPOTENCY_RETENTION_MS } from "./constants.js";
import { accountStorage } from "./capacity.js";
import { canonicalBatchJson, jsonResponse, sha256Hex } from "./http.js";
import { LEDGER_OUTCOME_LIMIT, LEDGER_RECOVERY_DELAY_MS, treeCoordinatorName } from "./forest.js";
import { retainedLedgerOutcomeCount } from "./ledger-capacity.js";
import { coordinatorObjectName, shardObjectName } from "./keys.js";
import { factAsJson } from "./protocol.js";
import { integer, planBatch, parseWritePlan, type WritePlan, type OwnerPlan, type ParticipantPlan } from "./plan.js";
import type { StorageEnv } from "./environment.js";
import type { BatchCache } from "./batch-cache.js";
import { classifyParticipantFailure, type ParticipantFailureCode } from "./transaction-diagnostics.js";

type Phase = "planning" | "reserving" | "preparing" | "committing" | "atomic-delegated" | "cancelling" | "complete" | "aborted";
type Intent = Readonly<{tx_id: string; graph_id: string; payload_hash: string; batch_json: string; trees_json: string;
  plan_json: string | null; phase: Phase; commit_seq: number; statement_time_ms: number; created_at_ms: number; local_witness_json: string | null; participant_witness: number}>;
type LocalWitness = Readonly<{status: "committed" | "aborted"; txId: string; graphId: string; payloadHash: string;
  commitSeq: number; statementTimeMs: number; identityTimeMs: number; shardPrefix: string; shardGeneration: number; directoryEpoch: number; factCount: number}>;
type ParticipantFailure = Readonly<{participant: number; status: number; reasonCode: ParticipantFailureCode}>;
type PreflightFailure = Readonly<{participant: number; status: number; reasonCode: ParticipantFailureCode | "split-required" | "capacity-not-admitted" | "invalid-preflight-response"}>;
type PlanningResult = {kind: "continue"; plan: WritePlan} | {kind: "respond"; response: Response};
type PreparationResult = {kind: "continue"} | {kind: "respond"; response: Response};

export class DistributedTransaction {
  private active = false;
  constructor(private readonly storage: DurableObjectStorage, private readonly env: StorageEnv,
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
    if (prior?.phase === "aborted") {
      console.error(JSON.stringify({event: "poneglyph.transaction.replayed-aborted", phase: "terminal"}));
      return this.aborted(prior);
    }
    if (this.active) return jsonResponse({error: "this transaction is active", retryable: true}, 423);
    this.active = true;
    try {
      if (!prior) {
        if (recovery) throw new Error("recovery cannot supply a new application transaction");
        const expiredBefore = Date.now() - TRANSACTION_IDEMPOTENCY_RETENTION_MS;
        this.storage.sql.exec(
          `DELETE FROM candidate_transactions WHERE tx_id IN (
            SELECT tx_id FROM candidate_transactions WHERE phase IN ('complete', 'aborted') AND created_at_ms < ? LIMIT 100
          )`, expiredBefore,
        );
        this.storage.sql.exec(
          `DELETE FROM client_request_tokens WHERE token_hash IN (
            SELECT token_hash FROM client_request_tokens WHERE terminal_at_ms IS NOT NULL AND created_at_ms < ? LIMIT 100
          )`, expiredBefore,
        );
        const count = retainedLedgerOutcomeCount(this.storage);
        const usesTokenReservation = this.storage.sql.exec(
          "SELECT 1 FROM client_request_tokens WHERE tx_id = ?", this.txId,
        ).toArray().length > 0;
        // Creating the journal fulfills the second slot already reserved by
        // this token mapping; ordinary transactions must claim a free slot.
        if (usesTokenReservation ? count > LEDGER_OUTCOME_LIMIT : count >= LEDGER_OUTCOME_LIMIT) {
          return jsonResponse({error: "ledger reached its shared retained-outcome allocation", retryable: false}, 429);
        }
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
    return this.env.GRAPH_TREES.getByName(treeCoordinatorName(intent.graph_id, owner.prefix)).fetch(`https://owner.internal/${action}`, {
      method: "POST", body: JSON.stringify({graphId: intent.graph_id, prefix: owner.prefix, txId: this.txId, payloadHash: intent.payload_hash,
        identityTimeMs: intent.created_at_ms, ...extra}),
    });
  }
  private async participant(intent: Intent, plan: WritePlan, participant: ParticipantPlan, batch: FactBatch, action: string): Promise<Response> {
    const owner = plan.owners.find(o => o.prefix === participant.owner)!;
    return this.env.GRAPH_SHARDS.getByName(shardObjectName(intent.graph_id, participant.address.prefix)).fetch(`https://shard.internal/${action}`, {
      method: "POST", body: JSON.stringify({graphId: intent.graph_id, shardPrefix: participant.address.prefix,
        shardGeneration: participant.address.generation, directoryEpoch: owner.directoryEpoch, txId: this.txId, payloadHash: intent.payload_hash,
        commitSeq: action === "_preflight" || action === "_prepare" || action === "_cancel" ? 0 : owner.publicationSeq,
        statementTimeMs: intent.statement_time_ms, identityTimeMs: intent.created_at_ms,
        ...(action === "_preflight" || action === "_prepare" || action === "_atomic" ? {facts: participant.entries.map(entry =>
          ({...entry, fact: factAsJson(batch.facts[entry.index]!)}))} : {})}),
    });
  }
  private async preflight(intent: Intent, plan: WritePlan, batch: FactBatch): Promise<readonly PreflightFailure[]> {
    const replies = await Promise.all(plan.participants.map(p => this.participant(intent, plan, p, batch, "_preflight")));
    const failures: PreflightFailure[] = [];
    for (const [participant, response] of replies.entries()) {
      let body: unknown;
      try { body = await response.json(); }
      catch {
        failures.push({participant, status: response.status, reasonCode: "invalid-preflight-response"});
        console.error(JSON.stringify({event: "poneglyph.transaction.preflight-failed", participant, status: response.status,
          reasonCode: "invalid-preflight-response"}));
        if (response.status >= 500) throw new Error("provisional capacity preflight unavailable");
        continue;
      }
      if (!response.ok) {
        failures.push({participant, status: response.status, reasonCode: classifyParticipantFailure(response.status, body)});
        if (response.status >= 500) {
          console.error(JSON.stringify({event: "poneglyph.transaction.preflight-failed", participant, status: response.status,
            reasonCode: classifyParticipantFailure(response.status, body)}));
          throw new Error("provisional capacity preflight unavailable");
        }
        continue;
      }
      if (!isRecord(body) || typeof body["canAdmit"] !== "boolean" || typeof body["shouldSplit"] !== "boolean") {
        failures.push({participant, status: response.status, reasonCode: "invalid-preflight-response"});
        console.error(JSON.stringify({event: "poneglyph.transaction.preflight-failed", participant, status: response.status,
          reasonCode: "invalid-preflight-response"}));
        throw new Error("provisional capacity preflight returned an invalid response");
      }
      if (body["shouldSplit"] === true) failures.push({participant, status: response.status, reasonCode: "split-required"});
      if (body["canAdmit"] !== true) failures.push({participant, status: response.status, reasonCode: "capacity-not-admitted"});
    }
    return failures;
  }

  private async advance(recovery: boolean): Promise<Response> {
    let intent = this.read();
    if (intent === undefined) throw new Error("durable transaction intent is missing");
    if (recovery && intent.phase === "planning") return this.abortUnplannedRecovery();

    const batch = await this.batch(intent);
    let plan: WritePlan;
    let freshlyReserved = false;
    if (intent.phase === "planning") {
      const result = await this.planAndReserve(intent, batch);
      if (result.kind === "respond") return result.response;
      plan = result.plan;
      intent = this.read()!;
      freshlyReserved = true;
    } else {
      plan = await this.recoverPlan(intent, batch);
    }

    if (intent.phase === "reserving") return this.abortUnpreparedRecovery(intent, plan);
    if (intent.phase === "preparing") {
      const result = await this.prepareParticipants(intent, plan, batch, freshlyReserved);
      if (result.kind === "respond") return result.response;
      intent = this.read()!;
    }

    if (intent.phase === "atomic-delegated") {
      plan = await this.acquirePublicationGates(intent, plan);
      return this.finishAtomic(this.read()!, plan, batch);
    }
    if (intent.phase === "cancelling") {
      await this.cancel(intent, plan, batch);
      return this.aborted(this.read()!);
    }
    if (intent.phase !== "committing") throw new Error("unsupported durable transaction phase");

    plan = await this.acquirePublicationGates(intent, plan);
    intent = this.read()!;
    await this.applyParticipants(intent, plan, batch);
    await this.publish(intent, plan);
    await this.publishSafeVector(intent, plan);
    await this.releasePublicationGates(intent, plan);

    const terminal = this.phase("complete");
    await this.finalize(intent, plan, batch);
    return this.receipt(terminal);
  }

  private abortUnplannedRecovery(): Response {
    console.error(JSON.stringify({event: "poneglyph.transaction.aborted", phase: "planning", reasonCode: "recovery-before-plan"}));
    return this.aborted(this.phase("aborted"));
  }

  private async recoverPlan(intent: Intent, batch: FactBatch): Promise<WritePlan> {
    if (!intent.plan_json) throw new Error("admitted operation lost its exact plan");
    const reservation = intent.phase === "reserving" ? "optional" : "required";
    return parseWritePlan(intent.plan_json, intent.graph_id, batch, reservation);
  }

  private async planAndReserve(intent: Intent, batch: FactBatch): Promise<PlanningResult> {
    const initialPlan = await planBatch(this.env, intent.graph_id, batch, async prefix => {
      const response = await this.tree(intent, {prefix}, "_tree-directory");
      const value: unknown = await response.json();
      if (!response.ok || !isRecord(value)) throw new Error("provisional owner directory unavailable");
      return {directoryEpoch: integer(value["directoryEpoch"]), visibleSeq: integer(value["visibleSeq"])};
    });
    if (initialPlan.participants.length > MAX_TRANSACTION_PARTICIPANTS) {
      this.storage.sql.exec("DELETE FROM candidate_transactions WHERE tx_id = ?", this.txId);
      return {kind: "respond", response: jsonResponse({error: "participant limit exceeded", retryable: false}, 413)};
    }

    const preflightFailures = await this.preflight(intent, initialPlan, batch);
    // Persist exact possible ownership before the first reservation RPC.
    this.storage.sql.exec("UPDATE candidate_transactions SET phase = 'reserving', plan_json = ?, trees_json = ? WHERE tx_id = ?",
      JSON.stringify(initialPlan), JSON.stringify(initialPlan.owners.map(owner => owner.prefix)), this.txId);
    intent = this.read()!;

    const owners: OwnerPlan[] = [];
    for (const owner of initialPlan.owners) {
      const response = await this.tree(intent, owner, "_tree-lock", {entities: owner.entities, directoryEpoch: owner.directoryEpoch});
      const value: unknown = await response.json();
      if (!response.ok) {
        await this.release(intent, initialPlan, false);
        this.storage.sql.exec("DELETE FROM candidate_transactions WHERE tx_id = ?", this.txId);
        return {kind: "respond", response: jsonResponse(
          isRecord(value) ? value : {error: "owner reservation rejected", retryable: true}, response.status,
        )};
      }
      if (!isRecord(value) || integer(value["directoryEpoch"]) !== owner.directoryEpoch) {
        throw new Error("provisional owner epoch changed");
      }
      owners.push({...owner, reservationTicket: integer(value["reservationTicket"], 1)});
    }

    const plan = {...initialPlan, owners};
    this.storage.sql.exec(`UPDATE candidate_transactions SET phase = 'preparing', plan_json = ?, commit_seq = 0, statement_time_ms = ? WHERE tx_id = ?`,
      JSON.stringify(plan), Date.now(), this.txId);
    intent = this.read()!;

    // A provisional rejection is not authoritative after visibility changed.
    // Positive preflight never replaces actual prepare/atomic admission.
    if (preflightFailures.length > 0) {
      const recheckFailures = await this.preflight(intent, plan, batch);
      if (recheckFailures.length > 0) {
        console.error(JSON.stringify({event: "poneglyph.transaction.aborted", phase: "preflight",
          reasonCode: "capacity-or-routing-rejected", initialFailures: preflightFailures, recheckFailures}));
        await this.cancel(this.phase("cancelling"), plan, batch);
        return {kind: "respond", response: this.aborted(this.read()!)};
      }
    }
    return {kind: "continue", plan};
  }

  private async abortUnpreparedRecovery(intent: Intent, plan: WritePlan): Promise<Response> {
    // Recover uncertain ownership only; never create new reservations on alarm.
    console.error(JSON.stringify({event: "poneglyph.transaction.aborted", phase: "reserving", reasonCode: "recovery-before-prepare"}));
    await this.release(intent, plan, true);
    return this.aborted(this.phase("aborted"));
  }

  private async prepareParticipants(
    intent: Intent,
    plan: WritePlan,
    batch: FactBatch,
    freshlyReserved: boolean,
  ): Promise<PreparationResult> {
    if (!freshlyReserved) await this.verifyOwnerReservations(intent, plan);
    if (plan.participants.length === 1) {
      this.phase("atomic-delegated");
      return {kind: "continue"};
    }

    const replies = await Promise.all(plan.participants.map(participant =>
      this.participant(intent, plan, participant, batch, "_prepare")));
    const failures = (await Promise.all(replies.map(async (response, participant): Promise<ParticipantFailure | undefined> => {
      if (response.ok) {await response.arrayBuffer(); return undefined;}
      const text = await response.text();
      let body: unknown = text;
      try {body = JSON.parse(text) as unknown;} catch { /* classify only; never log the raw response */ }
      return {participant, status: response.status, reasonCode: classifyParticipantFailure(response.status, body)};
    }))).filter((failure): failure is ParticipantFailure => failure !== undefined);

    if (failures.some(failure => failure.status >= 400 && failure.status < 500)) {
      console.error(JSON.stringify({event: "poneglyph.transaction.aborted", phase: "prepare",
        reasonCode: "participant-rejected", failures}));
      await this.cancel(this.phase("cancelling"), plan, batch);
      return {kind: "respond", response: this.aborted(this.read()!)};
    }
    if (failures.length > 0) {
      console.error(JSON.stringify({event: "poneglyph.transaction.incomplete", phase: "prepare",
        reasonCode: "participant-unavailable", failures}));
      throw new Error("participant prepare incomplete");
    }
    this.phase("committing");
    return {kind: "continue"};
  }

  private async verifyOwnerReservations(intent: Intent, plan: WritePlan): Promise<void> {
    for (const owner of plan.owners) {
      const response = await this.tree(intent, owner, "_tree-lock", {entities: owner.entities, directoryEpoch: owner.directoryEpoch});
      const value: unknown = await response.json();
      if (!response.ok || !isRecord(value) || value["reservationTicket"] !== owner.reservationTicket ||
          value["directoryEpoch"] !== owner.directoryEpoch) {
        throw new Error("admitted prepare lost its exact owner reservation");
      }
    }
  }

  private async applyParticipants(intent: Intent, plan: WritePlan, batch: FactBatch): Promise<void> {
    if (intent.participant_witness === 1) return;
    const replies = await Promise.all(plan.participants.map(participant =>
      this.participant(intent, plan, participant, batch, "_commit")));
    const incomplete = replies.some(response => !response.ok);
    await Promise.all(replies.map(response => response.arrayBuffer()));
    if (incomplete) throw new Error("irrevocable commit apply incomplete");
    this.storage.sql.exec("UPDATE candidate_transactions SET participant_witness = 1 WHERE tx_id = ?", this.txId);
  }

  private witness(value: unknown, intent: Intent, plan: WritePlan, batch: FactBatch): LocalWitness {
    if (!isRecord(value) || value["status"] !== "committed" && value["status"] !== "aborted") throw new Error("invalid local decision witness");
    const participant = plan.participants[0]!, owner = plan.owners[0]!;
    const expected = {txId: this.txId, graphId: intent.graph_id, payloadHash: intent.payload_hash,
      commitSeq: owner.publicationSeq, statementTimeMs: intent.statement_time_ms, identityTimeMs: intent.created_at_ms,
      shardPrefix: participant.address.prefix, shardGeneration: participant.address.generation, directoryEpoch: owner.directoryEpoch,
      factCount: value["status"] === "committed" ? batch.facts.length : 0};
    for (const [key, field] of Object.entries(expected)) if (value[key] !== field) throw new Error("local decision witness changed its authority tuple");
    return {...expected, status: value["status"]};
  }
  private async finishAtomic(intent: Intent, plan: WritePlan, batch: FactBatch): Promise<Response> {
    if (plan.participants.length !== 1 || plan.owners.length !== 1) throw new Error("delegation changed physical authority");
    const participant = plan.participants[0]!;
    let witness: LocalWitness;
    let rejectionStatus = 0;
    let rejection: unknown;
    if (intent.local_witness_json) witness = this.witness(JSON.parse(intent.local_witness_json), intent, plan, batch);
    else {
      const response = await this.participant(intent, plan, participant, batch, "_atomic");
      const value: unknown = await response.json();
      if (!response.ok) throw new Error("local decision authority returned no terminal answer");
      if (isRecord(value) && value["status"] === "aborted") {
        rejectionStatus = typeof value["rejectionStatus"] === "number" ? value["rejectionStatus"] : 0;
        rejection = value["error"];
      }
      witness = this.witness(value, intent, plan, batch);
      // This witness must precede releasing topology/conflict fences. Recovery
      // must not require re-mutating a leaf that can now have become a router.
      this.storage.sql.exec("UPDATE candidate_transactions SET local_witness_json = ? WHERE tx_id = ?", JSON.stringify(witness), this.txId);
    }
    if (witness.status === "committed") {
      await this.publish(intent, plan);
      await this.publishSafeVector(intent, plan);
      await this.releasePublicationGates(intent, plan);
    } else {
      console.error(JSON.stringify({event: "poneglyph.transaction.aborted", phase: "atomic",
        reasonCode: classifyParticipantFailure(rejectionStatus, rejection), rejectionStatus}));
      await this.release(intent, plan, true);
      await this.releasePublicationGates(intent, plan);
    }
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
      const response = await this.tree(intent, owner, "_tree-finish", {
        reservationTicket: owner.reservationTicket, publicationSeq: owner.publicationSeq,
      });
      const ok = response.ok; await response.arrayBuffer(); if (!ok) throw new Error("owner publication incomplete");
    }
  }
  private async acquirePublicationGates(intent: Intent, initialPlan: WritePlan): Promise<WritePlan> {
    let plan = initialPlan;
    for (const owner of plan.owners) {
      if (owner.publicationSeq > 0) continue;
      let value: unknown;
      let response: Response;
      for (let attempt = 0; ; attempt++) {
        response = await this.tree(intent, owner, "_tree-gate", {
          reservationTicket: owner.reservationTicket, directoryEpoch: owner.directoryEpoch,
        });
        if (response.status !== 423 || attempt >= 11) { value = await response.json(); break; }
        await response.arrayBuffer();
        await new Promise(resolve => setTimeout(resolve, Math.min(100, 10 + attempt * 10)));
      }
      if (!response.ok || !isRecord(value) || value["reservationTicket"] !== owner.reservationTicket ||
          value["directoryEpoch"] !== owner.directoryEpoch) throw new Error("owner publication gate acquisition failed");
      const publicationSeq = integer(value["publicationSeq"], 1);
      if (publicationSeq <= owner.visibleSeq) throw new Error("owner publication revision did not advance its captured frontier");
      const owners = plan.owners.map(candidate => candidate.prefix === owner.prefix ? {...candidate, publicationSeq} : candidate);
      plan = {...plan, owners};
      this.storage.sql.exec("UPDATE candidate_transactions SET plan_json = ?, commit_seq = ? WHERE tx_id = ?",
        JSON.stringify(plan), Math.max(...owners.map(candidate => candidate.publicationSeq)), this.txId);
    }
    return plan;
  }
  private async publishSafeVector(intent: Intent, plan: WritePlan): Promise<void> {
    const response = await this.env.GRAPH_FACADES.getByName(coordinatorObjectName(intent.graph_id)).fetch("https://graph.internal/_publish-vector", {
      method: "POST", body: JSON.stringify({graphId: intent.graph_id, owners: plan.owners.map(owner => ({
        prefix: owner.prefix, directoryEpoch: owner.directoryEpoch, publicationSeq: owner.publicationSeq,
      }))}),
    });
    const ok = response.ok; await response.arrayBuffer();
    if (!ok) throw new Error("cluster safe-vector publication incomplete");
  }
  private async releasePublicationGates(intent: Intent, plan: WritePlan): Promise<void> {
    for (const owner of plan.owners) {
      const response = await this.tree(intent, owner, "_tree-release-gate", {
        reservationTicket: owner.reservationTicket, publicationSeq: owner.publicationSeq,
      });
      const ok = response.ok; await response.arrayBuffer(); if (!ok) throw new Error("owner publication gate release incomplete");
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
