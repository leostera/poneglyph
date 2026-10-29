import { parseFactBatch, type FactBatch } from "../domain/fact.js";
import type { GraphId } from "../domain/graph-id.js";
import { isRecord } from "../domain/result.js";
import { MAX_TRANSACTION_BYTES, MAX_TRANSACTION_FACTS, MAX_TRANSACTION_PARTICIPANTS, TRANSACTION_IDEMPOTENCY_RETENTION_MS } from "./constants.js";
import { accountStorage } from "./capacity.js";
import { canonicalBatchJson, jsonResponse, sha256Hex } from "./http.js";
import { LEDGER_OUTCOME_LIMIT, LEDGER_RECOVERY_DELAY_MS, treeCoordinatorName } from "./forest.js";
import { evictLedgerOutcomes, retainedLedgerOutcomeCount } from "./ledger-capacity.js";
import { coordinatorObjectName, shardObjectName } from "./keys.js";
import { factAsJson } from "./protocol.js";
import { integer, planBatch, parseWritePlan, type WritePlan, type OwnerPlan, type ParticipantPlan } from "./plan.js";
import type { StorageEnv } from "./environment.js";
import type { BatchCache } from "./batch-cache.js";
import { writeDirectoryCache } from "./directory-cache.js";
import { OWNER_TOPOLOGY_FENCED, STALE_OWNER_EPOCH } from "./owner-writes.js";
import { classifyParticipantFailure, type ParticipantFailureCode } from "./transaction-diagnostics.js";

type Phase = "planning" | "reserving" | "preparing" | "committing" | "atomic-delegated" | "cancelling" | "complete" | "aborted";
type Intent = Readonly<{tx_id: string; graph_id: string; payload_hash: string; batch_json: string; trees_json: string;
  plan_json: string | null; phase: Phase; commit_seq: number; statement_time_ms: number; created_at_ms: number; local_witness_json: string | null; participant_witness: number}>;
type LocalWitness = Readonly<{status: "committed" | "aborted"; txId: string; graphId: string; payloadHash: string;
  commitSeq: number; statementTimeMs: number; identityTimeMs: number; shardPrefix: string; shardGeneration: number; directoryEpoch: number; factCount: number}>;
type ParticipantFailure = Readonly<{participant: number; status: number; reasonCode: ParticipantFailureCode}>;
type PlanningResult = {kind: "continue"; plan: WritePlan} | {kind: "respond"; response: Response};
type PreparationResult = {kind: "continue"} | {kind: "respond"; response: Response};

const MAX_PLANNING_ATTEMPTS = 3;
/** How long a write waits, replanning, for an owner that is fenced for a split. */
const MAX_FENCE_WAIT_MS = 30_000;

export class DistributedTransaction {
  private active = false;
  // Wall time spent waiting on each kind of call, reported as Server-Timing.
  private readonly timings = new Map<string, number>();
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
        let count = retainedLedgerOutcomeCount(this.storage);
        if (count >= LEDGER_OUTCOME_LIMIT) {evictLedgerOutcomes(this.storage); count = retainedLedgerOutcomeCount(this.storage);}
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
      const started = Date.now();
      await this.timed("ledger-schedule", () => this.scheduleRecovery());
      const response = await this.advance(recovery);
      this.timings.set("ledger-total", Date.now() - started);
      return withServerTiming(response, this.timings);
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
    // A terminal outcome answers replays from its payload hash; the batch itself is no longer needed.
    if (phase === "complete" || phase === "aborted")
      this.storage.sql.exec("UPDATE candidate_transactions SET phase = ?, batch_json = '' WHERE tx_id = ?", phase, this.txId);
    else this.storage.sql.exec("UPDATE candidate_transactions SET phase = ? WHERE tx_id = ?", phase, this.txId);
    return this.read()!;
  }
  private receipt(intent: Intent): Response {return jsonResponse({txId: this.txId, status: "committed", commitSeq: intent.commit_seq, sequenceScope: "subtree-vector"});}
  private aborted(intent: Intent): Response {return jsonResponse({txId: intent.tx_id, status: "aborted", retryable: false}, 422);}
  private async batch(intent: Intent): Promise<FactBatch> {
    const cached = this.cache.get(this.txId, intent.batch_json); if (cached) return cached;
    const parsed = parseFactBatch(JSON.parse(intent.batch_json));
    if (!parsed.ok || parsed.value.txId !== this.txId || await sha256Hex(canonicalBatchJson(parsed.value)) !== intent.payload_hash) throw new Error("corrupt durable canonical journal");
    this.cache.put(this.txId, intent.batch_json, parsed.value); return parsed.value;
  }
  private async timed<T>(name: string, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {return await run();}
    finally {this.timings.set(name, (this.timings.get(name) ?? 0) + Date.now() - started);}
  }
  private async tree(intent: Intent, owner: Pick<OwnerPlan, "prefix">, action: string, extra: object = {}): Promise<Response> {
    return this.timed(action, () => this.treeCall(intent, owner, action, extra));
  }
  private async treeCall(intent: Intent, owner: Pick<OwnerPlan, "prefix">, action: string, extra: object): Promise<Response> {
    return this.env.GRAPH_TREES.getByName(treeCoordinatorName(intent.graph_id, owner.prefix)).fetch(`https://owner.internal/${action}`, {
      method: "POST", body: JSON.stringify({graphId: intent.graph_id, prefix: owner.prefix, txId: this.txId, payloadHash: intent.payload_hash,
        identityTimeMs: intent.created_at_ms, ...extra}),
    });
  }
  private async participant(intent: Intent, plan: WritePlan, participant: ParticipantPlan, batch: FactBatch, action: string): Promise<Response> {
    return this.timed(action, () => this.participantCall(intent, plan, participant, batch, action));
  }
  private async participantCall(intent: Intent, plan: WritePlan, participant: ParticipantPlan, batch: FactBatch, action: string): Promise<Response> {
    const owner = plan.owners.find(o => o.prefix === participant.owner)!;
    return this.env.GRAPH_SHARDS.getByName(shardObjectName(intent.graph_id, participant.address.prefix)).fetch(`https://shard.internal/${action}`, {
      method: "POST", body: JSON.stringify({graphId: intent.graph_id, shardPrefix: participant.address.prefix,
        shardGeneration: participant.address.generation, directoryEpoch: owner.directoryEpoch, txId: this.txId, payloadHash: intent.payload_hash,
        commitSeq: action === "_prepare" || action === "_cancel" ? 0 : owner.publicationSeq,
        statementTimeMs: intent.statement_time_ms, identityTimeMs: intent.created_at_ms,
        ...(action === "_prepare" || action === "_atomic" ? {facts: participant.entries.map(entry =>
          ({...entry, fact: factAsJson(batch.facts[entry.index]!)}))} : {})}),
    });
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

    return this.receipt(this.phase("complete"));
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

  private async planAndReserve(intent: Intent, batch: FactBatch, attempt = 0, fencedSince?: number): Promise<PlanningResult> {
    // Directory entries and routes come from the ledger's cache when it has
    // them; the owner lock below rejects a plan built on a stale epoch.
    const initialPlan = await planBatch(this.env, intent.graph_id, batch,
      prefix => writeDirectoryCache.owner(intent.graph_id, prefix, async () => {
        const response = await this.tree(intent, {prefix}, "_tree-directory");
        const value: unknown = await response.json();
        if (!response.ok || !isRecord(value)) throw new Error("provisional owner directory unavailable");
        return {directoryEpoch: integer(value["directoryEpoch"]), visibleSeq: integer(value["visibleSeq"])};
      }),
      (graph, owner, key, epoch) => writeDirectoryCache.leaf(this.env, graph, owner, key, epoch));
    if (initialPlan.participants.length > MAX_TRANSACTION_PARTICIPANTS) {
      this.storage.sql.exec("DELETE FROM candidate_transactions WHERE tx_id = ?", this.txId);
      return {kind: "respond", response: jsonResponse({error: "participant limit exceeded", retryable: false}, 413)};
    }

    // Persist exact possible ownership before the first reservation RPC.
    this.storage.sql.exec("UPDATE candidate_transactions SET phase = 'reserving', plan_json = ?, trees_json = ? WHERE tx_id = ?",
      JSON.stringify(initialPlan), JSON.stringify(initialPlan.owners.map(owner => owner.prefix)), this.txId);
    intent = this.read()!;

    const owners: OwnerPlan[] = [];
    // A single-owner, single-shard write needs the publication gate right
    // after its lock, so take both in one owner call.
    const gate = isSingleOwnerAtomic(initialPlan);
    for (const owner of initialPlan.owners) {
      const response = await this.tree(intent, owner, "_tree-lock", {entities: owner.entities, directoryEpoch: owner.directoryEpoch, gate});
      const value: unknown = await response.json();
      if (!response.ok) {
        await this.release(intent, initialPlan, false);
        if (response.status === 409 && isRecord(value) && value["error"] === STALE_OWNER_EPOCH && attempt < MAX_PLANNING_ATTEMPTS - 1) {
          // The owner split since this ledger cached its directory: plan again.
          writeDirectoryCache.forgetOwners(intent.graph_id, initialPlan.owners.map(candidate => candidate.prefix));
          this.storage.sql.exec("UPDATE candidate_transactions SET phase = 'planning', plan_json = NULL, trees_json = '[]' WHERE tx_id = ?", this.txId);
          return this.planAndReserve(this.read()!, batch, attempt + 1, fencedSince);
        }
        const now = Date.now();
        if (response.status === 423 && isRecord(value) && value["error"] === OWNER_TOPOLOGY_FENCED && now - (fencedSince ?? now) < MAX_FENCE_WAIT_MS) {
          // The owner is splitting: wait and plan again against its new directory.
          writeDirectoryCache.forgetOwners(intent.graph_id, initialPlan.owners.map(candidate => candidate.prefix));
          this.storage.sql.exec("UPDATE candidate_transactions SET phase = 'planning', plan_json = NULL, trees_json = '[]' WHERE tx_id = ?", this.txId);
          await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));
          return this.planAndReserve(this.read()!, batch, 0, fencedSince ?? now);
        }
        this.storage.sql.exec("DELETE FROM candidate_transactions WHERE tx_id = ?", this.txId);
        return {kind: "respond", response: jsonResponse(
          isRecord(value) ? value : {error: "owner reservation rejected", retryable: true}, response.status,
        )};
      }
      if (!isRecord(value) || integer(value["directoryEpoch"]) !== owner.directoryEpoch) {
        throw new Error("provisional owner epoch changed");
      }
      const publicationSeq = gate ? integer(value["publicationSeq"], 1) : 0;
      if (publicationSeq > 0 && publicationSeq <= owner.visibleSeq) throw new Error("owner publication revision did not advance its captured frontier");
      owners.push({...owner, reservationTicket: integer(value["reservationTicket"], 1), publicationSeq});
    }

    const plan = {...initialPlan, owners};
    this.storage.sql.exec(`UPDATE candidate_transactions SET phase = 'preparing', plan_json = ?, commit_seq = ?, statement_time_ms = ? WHERE tx_id = ?`,
      JSON.stringify(plan), Math.max(0, ...owners.map(owner => owner.publicationSeq)), Date.now(), this.txId);
    intent = this.read()!;

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
      // One owner: its finish answers once the graph's safe vector shows the write.
      await this.publish(intent, plan, true);
    } else {
      console.error(JSON.stringify({event: "poneglyph.transaction.aborted", phase: "atomic",
        reasonCode: classifyParticipantFailure(rejectionStatus, rejection), rejectionStatus}));
      // Releasing the reservation also gives up its unheld publication revision.
      await this.release(intent, plan, true);
    }
    const terminal = this.phase(witness.status === "committed" ? "complete" : "aborted");
    return witness.status === "committed" ? this.receipt(terminal) : this.aborted(terminal);
  }
  private async publish(intent: Intent, plan: WritePlan, singleOwner = false): Promise<void> {
    if (singleOwner && plan.owners.length !== 1) throw new Error("only a single-owner write may publish through its owner");
    // Every owner already holds its gate, so publication order between owners does not matter.
    await Promise.all(plan.owners.map(async owner => {
      const response = await this.tree(intent, owner, "_tree-finish", {
        reservationTicket: owner.reservationTicket, publicationSeq: owner.publicationSeq, singleOwner,
      });
      const ok = response.ok; await response.arrayBuffer(); if (!ok) throw new Error("owner publication incomplete");
    }));
  }
  private async acquirePublicationGates(intent: Intent, initialPlan: WritePlan): Promise<WritePlan> {
    let plan = initialPlan;
    for (const owner of plan.owners) {
      if (owner.publicationSeq > 0) continue;
      let value: unknown;
      let response: Response;
      for (let attempt = 0; ; attempt++) {
        // Only a distributed write holds its revisions out of the safe vector until it publishes them together.
        response = await this.tree(intent, owner, "_tree-gate", {
          reservationTicket: owner.reservationTicket, directoryEpoch: owner.directoryEpoch, held: plan.owners.length > 1,
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
    await Promise.all(plan.owners.map(async owner => {
      const response = await this.tree(intent, owner, "_tree-release-gate", {
        reservationTicket: owner.reservationTicket, publicationSeq: owner.publicationSeq,
      });
      const ok = response.ok; await response.arrayBuffer(); if (!ok) throw new Error("owner publication gate release incomplete");
    }));
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
  }
}

function isSingleOwnerAtomic(plan: WritePlan): boolean {
  return plan.owners.length === 1 && plan.participants.length === 1;
}

function withServerTiming(response: Response, timings: ReadonlyMap<string, number>): Response {
  if (timings.size === 0) return response;
  const headers = new Headers(response.headers);
  headers.set("server-timing", [...timings].map(([name, ms]) => `${name.replace(/[^a-z0-9-]/gi, "")};dur=${ms}`).join(", "));
  return new Response(response.body, {status: response.status, headers});
}
