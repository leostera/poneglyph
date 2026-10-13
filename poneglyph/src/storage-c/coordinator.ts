import { DurableObject } from "cloudflare:workers";
import type { CandidateStorageEnv as Env } from "./environment.js";
import { parseFactBatch, type FactBatch, type FactDraft } from "../domain/fact.js";
import { parseGraphId, type GraphId } from "../domain/graph-id.js";
import { parseUri } from "../domain/identifiers.js";
import { isRecord } from "../domain/result.js";
import { evaluateDatalog, QueryResultLimitExceeded } from "../datalog/evaluator.js";
import { parseDatalogQuery } from "../datalog/parser.js";
import { DistributedFactSource } from "./distributed-fact-source.js";
import { QueryScanBudgetExceeded } from "../datalog/scan-stream.js";
import {
  MAX_QUERY_RESPONSE_BYTES,
  MAX_QUERY_RESULTS,
  MAX_READ_LEASES,
  MAX_RETAINED_TRANSACTION_OUTCOMES,
  MAX_TRANSACTION_BYTES,
  MAX_TRANSACTION_FACTS,
  MAX_TRANSACTION_PARTICIPANTS,
  MAX_SPLITS_PER_WRITE,
  QUERY_TIMEOUT_MS,
  READ_LEASE_TTL_MS,
  ROUTING_VERSION,
  TRANSACTION_IDEMPOTENCY_RETENTION_MS,
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
import { accountStorage } from "./capacity.js";
import { matchesPrefix, parseVirtualPrefix, shardObjectName, virtualKeyForEntity, type VirtualKey, type VirtualPrefix } from "./keys.js";
import { listShardLeaves, resolveEntityLeaf, type LeafAddress } from "./routing.js";
import { factAsJson } from "./protocol.js";
import { ensureCoordinatorSchema } from "./sql.js";
import { TransactionLedger } from "./ledger.js";
import { TREE_PREFIXES, TREE_DEPTH, TREE_OUTCOME_LIMIT, treeCoordinatorName, transactionCoordinatorName, treeForKey, type TreeSnapshot } from "./forest.js";

type TransactionPhase = "preparing" | "committing" | "cancelling" | "complete" | "aborted";

type GraphStateRow = Readonly<{
  visible_seq: number;
  directory_epoch: number;
  writer_tx_id: string | null;
  topology_op_id: string | null;
  next_statement_time_ms: number;
}>;

type TransactionRow = Readonly<{
  tx_id: string;
  payload_hash: string;
  batch_json: string | null;
  participants_json: string;
  directory_epoch: number;
  statement_time_ms: number;
  commit_seq: number;
  phase: TransactionPhase;
  created_at_ms: number;
}>;

type PreparedParticipant = Readonly<{
  address: LeafAddress;
  facts: readonly Readonly<{ index: number; fact: FactDraft; virtualKey: VirtualKey }>[];
}>;

type ParticipantReference = LeafAddress;
type ReadLease = Readonly<{ readId: string; snapshotSeq: number; directoryEpoch: number; expiresAtMs: number }>;

type SplitRow = Readonly<{
  migration_id: string;
  source_prefix: string;
  source_generation: number;
  left_prefix: string;
  right_prefix: string;
  base_visible_seq: number;
  old_directory_epoch: number;
  split_epoch: number;
  phase: "copying" | "ready" | "cutover" | "retired";
  force: number;
  created_at_ms: number;
}>;

type ResumeOutcome = "committed" | "aborted";

export class GraphCoordinatorDO extends DurableObject<Env> {
  private activeWriterTxId: string | undefined;
  private activeTopologyOpId: string | undefined;
  private readonly ledger: TransactionLedger;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ledger = new TransactionLedger(ctx.storage, env);
    void ctx.blockConcurrencyWhile(async () => ensureCoordinatorSchema(ctx.storage));
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/_transact") return this.ledger.fetch(request);
    if (request.method === "POST" && path === "/_transaction-audit") {
      const txId = new URL(request.url).searchParams.get("txId");
      return jsonResponse(this.ctx.storage.sql.exec("SELECT tx_id, phase, payload_hash FROM candidate_transactions WHERE tx_id = ?", txId).toArray());
    }
    if (request.method === "POST" && path === "/_ledger-audit") return jsonResponse({
      context: this.ctx.storage.sql.exec("SELECT * FROM ledger_context").toArray(),
      phases: this.ctx.storage.sql.exec("SELECT phase, COUNT(*) AS count FROM candidate_transactions GROUP BY phase").toArray(),
      databaseBytes: this.ctx.storage.sql.databaseSize,
    });
    if (request.method === "POST" && path.startsWith("/_tree-")) {
      try { return await this.treeControl(request); }
      catch (error) { const status = error instanceof CoordinatorError ? error.status : 503;
        return jsonResponse({ error: errorMessage(error), retryable: error instanceof CoordinatorError ? error.retryable : true }, status); }
    }
    if (request.method === "POST" && path === "/_split") {
      const raw = await readJsonBody(request, 8192);
      if (!raw.ok || !isRecord(raw.value)) return jsonResponse({error: "invalid split envelope"}, 400);
      const graph = parseGraphId(raw.value["graphId"]), prefix = parseVirtualPrefix(raw.value["prefix"]);
      if (!graph.ok || !prefix.ok || prefix.value.length < TREE_DEPTH) return jsonResponse({error: "cannot split a virtual forest router"}, 400);
      const root = prefix.value.slice(0, TREE_DEPTH) as VirtualPrefix;
      return this.env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graph.value, root)).fetch("https://tree.internal/_tree-split", {
        method: "POST", body: JSON.stringify({...raw.value, prefix: root, sourcePrefix: prefix.value}),
      });
    }
    const route = parseGraphRoute(request);
    if (route === undefined) return jsonResponse({ error: "not found" }, 404);

    try {
      this.assertGraphIdentity(route.graphId);
      if (route.action === "transactions" && request.method === "POST") {
        const raw = await readJsonBody(request, MAX_TRANSACTION_BYTES);
        if (!raw.ok) return jsonResponse({error: raw.error.message}, 400);
        const parsed = parseBatchBody(raw.value);
        if (!parsed.ok) return jsonResponse({error: parsed.error.message}, 400);
        return this.env.GRAPH_COORDINATORS.getByName(await transactionCoordinatorName(route.graphId, parsed.value.batch.txId)).fetch("https://transaction.internal/_transact", {
          method: "POST", body: JSON.stringify({graphId: route.graphId, batch: parsed.value.batch}),
        });
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
      return jsonResponse({ error: errorMessage(error), retryable: error instanceof CoordinatorError ? error.retryable : true }, status);
    }
  }

  override async alarm(): Promise<void> { await this.ledger.alarm(); }

  private async requestSplit(request: Request): Promise<Response> {
    const input = await readJsonBody(request, 8_192);
    if (!input.ok || !isRecord(input.value)) return jsonResponse({ error: "expected a split request object" }, 400);
    const graphId = parseGraphId(input.value["graphId"]);
    const prefix = parseVirtualPrefix(input.value["prefix"]);
    const force = input.value["force"] === true;
    const stopAfterPages = input.value["stopAfterPages"];
    if (!graphId.ok || !prefix.ok || (stopAfterPages !== undefined &&
        (typeof stopAfterPages !== "number" || !Number.isSafeInteger(stopAfterPages) || stopAfterPages < 1))) {
      return jsonResponse({ error: "invalid split request identity" }, 400);
    }
    this.assertGraphIdentity(graphId.value);
    const current = this.readGraphState();
    const route = await this.postShard(prefix.value, "_route", {
      graphId: graphId.value,
      prefix: prefix.value,
      directoryEpoch: current.directory_epoch,
    });
    if (route["kind"] === "router") {
      return jsonResponse({ status: "already-split", prefix: prefix.value, directoryEpoch: current.directory_epoch, visibleSeq: current.visible_seq });
    }
    const migrationId = this.reserveSplit(prefix.value, force);
    const interrupted = await this.performSplit(migrationId, stopAfterPages as number | undefined);
    if (interrupted instanceof Response) return interrupted;
    const state = this.readGraphState();
    return jsonResponse({ status: "split", prefix: prefix.value, directoryEpoch: state.directory_epoch, visibleSeq: state.visible_seq });
  }

  private reserveSplit(prefix: VirtualPrefix, force: boolean): string {
    return this.ctx.storage.transactionSync(() => {
      const state = this.readGraphState();
      if (state.writer_tx_id !== null) throw new CoordinatorError(423, "cannot split while a transaction decision is pending");
      if (state.topology_op_id !== null) {
        const existing = this.readSplit(state.topology_op_id);
        if (existing?.source_prefix === prefix) return state.topology_op_id;
        throw new CoordinatorError(423, "another topology operation is already active");
      }
      const capacity = accountStorage(this.ctx.storage.sql.databaseSize, {
        factLogBytes: 0,
        activeIndexBytes: 0,
        projectionBytes: 0,
        transactionStagingBytes: 2_048,
      });
      if (!capacity.canAdmit) throw new CoordinatorError(413, "coordinator cannot reserve metadata for another topology operation");
      const migrationId = crypto.randomUUID();
      const leftPrefix = `${prefix}0`;
      const rightPrefix = `${prefix}1`;
      const splitEpoch = state.directory_epoch + 1;
      this.ctx.storage.sql.exec(
        `INSERT INTO graph_splits
         (migration_id, source_prefix, source_generation, left_prefix, right_prefix, base_visible_seq,
          old_directory_epoch, split_epoch, phase, force, created_at_ms)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?, 'copying', ?, ?)`,
        migrationId,
        prefix,
        leftPrefix,
        rightPrefix,
        state.visible_seq,
        state.directory_epoch,
        splitEpoch,
        force ? 1 : 0,
        Date.now(),
      );
      this.ctx.storage.sql.exec("UPDATE graph_state SET topology_op_id = ? WHERE singleton = 1", migrationId);
      return migrationId;
    });
  }

  private async performSplit(migrationId: string, stopAfterPages?: number): Promise<Response | undefined> {
    if (this.activeTopologyOpId !== undefined) return this.topologyBusy(this.activeTopologyOpId);
    this.activeTopologyOpId = migrationId;
    try {
      return await this.performSplitStep(migrationId, stopAfterPages);
    } finally {
      this.activeTopologyOpId = undefined;
    }
  }

  private async performSplitStep(migrationId: string, stopAfterPages?: number): Promise<Response | undefined> {
    const split = this.readSplit(migrationId);
    if (split === undefined) throw new CoordinatorError(500, "topology operation record is missing");
    if (split.phase === "retired" || split.phase === "cutover") return undefined;
    const graphId = this.readGraphIdentity();
    const sourcePrefix = split.source_prefix as VirtualPrefix;
    const splitIdentity = {
      graphId,
      prefix: sourcePrefix,
      generation: split.source_generation,
      migrationId,
      splitEpoch: split.split_epoch,
      leftPrefix: split.left_prefix,
      rightPrefix: split.right_prefix,
      force: split.force === 1,
    };
    const started = await this.postShard(sourcePrefix, "_begin-split", splitIdentity);
    const beginStatus = started["status"];
    if (beginStatus === "capacity-limit" || beginStatus === "no-progress") {
      await this.postShard(sourcePrefix, "_abort-split", { graphId, prefix: sourcePrefix, migrationId });
      this.clearSplit(migrationId);
      throw new CoordinatorError(413, beginStatus === "capacity-limit"
        ? "split children cannot fit under the per-DO accounted capacity limit"
        : "virtual-prefix split would make no progress");
    }
    if (beginStatus !== "copying" && beginStatus !== "already-cut-over") {
      throw new CoordinatorError(503, "source did not enter the expected split state");
    }

    let copiedPages = 0;
    if (beginStatus !== "already-cut-over") {
      const children = [split.left_prefix, split.right_prefix] as const;
      const reserves = [started["leftReservedBytes"], started["rightReservedBytes"]];
      for (const [index, childPrefix] of children.entries()) {
        const reservedBytes = reserves[index];
        if (typeof reservedBytes !== "number" || !Number.isSafeInteger(reservedBytes) || reservedBytes < 0) {
          throw new CoordinatorError(500, "source returned an invalid child capacity estimate");
        }
        await this.postShard(childPrefix as VirtualPrefix, "_init-child", { graphId, prefix: childPrefix, migrationId, reservedBytes });
      }

      for (const table of ["fact_log", "active_facts", "active_values", "entity_versions"] as const) {
        for (const childPrefix of children) {
          let pageNumber = 0;
          let afterRowId = 0;
          while (true) {
            const exported = await this.postShard(sourcePrefix, "_export", {
              graphId,
              sourcePrefix,
              targetPrefix: childPrefix,
              migrationId,
              table,
              pageNumber,
              afterRowId,
            });
            const rows = exported["rows"];
            const nextRowId = exported["nextRowId"];
            const hasMore = exported["hasMore"];
            const pageHash = exported["pageHash"];
            if (!Array.isArray(rows) || typeof nextRowId !== "number" || typeof hasMore !== "boolean" || typeof pageHash !== "string") {
              throw new CoordinatorError(502, "source returned an invalid split page");
            }
            if (rows.length > 0) {
              await this.postShard(childPrefix as VirtualPrefix, "_import", {
                graphId,
                targetPrefix: childPrefix,
                migrationId,
                table,
                pageNumber,
                pageHash,
                rows,
              });
              copiedPages += 1;
              if (stopAfterPages !== undefined && copiedPages >= stopAfterPages) {
                return jsonResponse({ status: "copy-interrupted-for-recovery-test", migrationId, copiedPages }, 503, { "retry-after": "1" });
              }
            }
            if (!hasMore) break;
            if (nextRowId <= afterRowId || pageNumber > 1_000_000) throw new CoordinatorError(500, "split export cursor failed to advance");
            afterRowId = nextRowId;
            pageNumber += 1;
          }
        }
      }

      for (const table of ["fact_log", "active_facts", "active_values", "entity_versions"] as const) {
        for (const childPrefix of children) {
          const sourceCount = await this.postShard(sourcePrefix, "_count", {
            graphId, nodePrefix: sourcePrefix, rangePrefix: childPrefix, table,
          });
          const childCount = await this.postShard(childPrefix as VirtualPrefix, "_count", {
            graphId, nodePrefix: childPrefix, rangePrefix: childPrefix, table,
          });
          if (sourceCount["count"] !== childCount["count"]) {
            throw new CoordinatorError(503, `split verification count mismatch for ${table} at prefix ${childPrefix}`);
          }
        }
      }
      for (const childPrefix of children) {
        await this.postShard(childPrefix as VirtualPrefix, "_finish-child", { graphId, prefix: childPrefix, migrationId });
      }
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("UPDATE graph_splits SET phase = 'ready' WHERE migration_id = ? AND phase = 'copying'", migrationId);
      });
    }

    await this.postShard(sourcePrefix, "_cutover", splitIdentity);
    this.ctx.storage.transactionSync(() => {
      const state = this.readGraphState();
      if (state.directory_epoch === split.old_directory_epoch) {
        if (state.topology_op_id !== migrationId || state.visible_seq !== split.base_visible_seq) {
          throw new CoordinatorError(500, "graph state changed during a fenced topology operation");
        }
        this.ctx.storage.sql.exec(
          "UPDATE graph_state SET directory_epoch = ?, topology_op_id = NULL WHERE singleton = 1",
          split.split_epoch,
        );
      } else if (state.directory_epoch !== split.split_epoch) {
        throw new CoordinatorError(500, "directory epoch changed unexpectedly during split recovery");
      }
      this.ctx.storage.sql.exec("UPDATE graph_splits SET phase = 'cutover' WHERE migration_id = ?", migrationId);
    });
    await this.pruneVersions();
    return undefined;
  }

  private async postShard(prefix: VirtualPrefix, path: string, body: unknown): Promise<Record<string, unknown>> {
    const stub = this.env.GRAPH_SHARDS.getByName(shardObjectName(this.readGraphIdentity(), prefix));
    const response = await stub.fetch(`https://shard.internal/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let result: unknown;
    try { result = JSON.parse(text) as unknown; } catch { result = undefined; }
    if (!response.ok) throw new ParticipantResponseError(response.status, text.slice(0, 512));
    if (!isRecord(result)) throw new CoordinatorError(502, `shard ${prefix} returned invalid JSON`);
    return result;
  }

  private readSplit(migrationId: string): SplitRow | undefined {
    return this.ctx.storage.sql.exec<SplitRow>(
      `SELECT migration_id, source_prefix, source_generation, left_prefix, right_prefix, base_visible_seq,
        old_directory_epoch, split_epoch, phase, force, created_at_ms FROM graph_splits WHERE migration_id = ?`,
      migrationId,
    ).toArray()[0];
  }

  private clearSplit(migrationId: string): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM graph_splits WHERE migration_id = ? AND phase = 'copying'", migrationId);
      this.ctx.storage.sql.exec("UPDATE graph_state SET topology_op_id = NULL WHERE singleton = 1 AND topology_op_id = ?", migrationId);
    });
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
    const knownOutcome = this.transactionOutcome(batch.txId, payloadHash);
    if (knownOutcome !== undefined) return knownOutcome;
    if (this.activeWriterTxId !== undefined) {
      return this.writerBusy(this.activeWriterTxId);
    }

    const existingWriter = this.readGraphState().writer_tx_id;
    if (existingWriter !== null && this.isExternalWriter(existingWriter)) return this.writerBusy(existingWriter);
    if (this.hasReadLease()) return jsonResponse({ error: "subtree read cut is active", retryable: true }, 423);
    if (existingWriter !== null) {
      const outcome = await this.resumePersistedWriter(existingWriter);
      if (outcome instanceof Response) return outcome;
    }
    const pendingTopology = this.readGraphState().topology_op_id;
    if (pendingTopology !== null) {
      const outcome = await this.performSplit(pendingTopology);
      if (outcome instanceof Response) return outcome;
    }

    // Recovery may have completed this request's transaction while we awaited it.
    const recoveredOutcome = this.transactionOutcome(batch.txId, payloadHash);
    if (recoveredOutcome !== undefined) return recoveredOutcome;

    let routeState = this.readGraphState();
    if (routeState.topology_op_id !== null) return this.topologyBusy(routeState.topology_op_id);
    let directoryEpoch = routeState.directory_epoch;
    let participants = await this.groupBatch(batch, directoryEpoch);
    for (let splitCount = 0; splitCount <= MAX_SPLITS_PER_WRITE; splitCount += 1) {
      if (participants.length > MAX_TRANSACTION_PARTICIPANTS) {
        return jsonResponse({ error: `transaction cannot exceed ${MAX_TRANSACTION_PARTICIPANTS} participant leaves` }, 413);
      }
      const preflight = await this.preflightParticipants(batch, payloadHash, participants, directoryEpoch);
      const overloaded = preflight.find((result) => result.shouldSplit || !result.canAdmit);
      if (overloaded === undefined) break;
      if (!overloaded.shouldSplit || splitCount === MAX_SPLITS_PER_WRITE) {
        return jsonResponse({ error: "transaction cannot be admitted within the per-DO capacity budget", prefix: overloaded.address.prefix }, 413);
      }
      const splitResult = await this.splitPrefix(overloaded.address.prefix, false);
      if (splitResult instanceof Response) return splitResult;
      routeState = this.readGraphState();
      directoryEpoch = routeState.directory_epoch;
      participants = await this.groupBatch(batch, directoryEpoch);
    }

    const reservation = this.reserveTransaction(batch, payloadHash, json, participants, directoryEpoch);
    if (reservation.kind === "busy") return this.writerBusy(reservation.txId);
    if (reservation.kind === "topology-busy") return this.topologyBusy(this.readGraphState().topology_op_id ?? "split");
    if (reservation.kind === "route-changed") {
      return jsonResponse({ error: "directory changed while routing transaction; retry with the same txId", retryable: true }, 423, { "retry-after": "1" });
    }
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

  private transactionOutcome(txId: string, payloadHash: string): Response | undefined {
    const prior = this.readTransaction(txId);
    if (prior === undefined) return undefined;
    if ((prior.phase === "complete" || prior.phase === "aborted") &&
        prior.created_at_ms < Date.now() - TRANSACTION_IDEMPOTENCY_RETENTION_MS) {
      this.ctx.storage.sql.exec("DELETE FROM graph_transactions WHERE tx_id = ?", txId);
      return undefined;
    }
    if (prior.payload_hash !== payloadHash) {
      return jsonResponse({ error: "txId has already been used with a different fact batch" }, 409);
    }
    if (prior.phase === "complete") return jsonResponse({ txId, commitSeq: prior.commit_seq, status: "committed" });
    if (prior.phase === "aborted") return jsonResponse({ txId, status: "aborted" }, 409);
    // Preparing/committing/cancelling must still be recovered before an outcome is final.
    return undefined;
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
      const references = this.readParticipantReferences(transaction);
      const participants = await this.groupBatch(batch.value, transaction.directory_epoch, references);
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

    const participants = this.readParticipantReferences(transaction);
    const commitResults = await Promise.allSettled(participants.map((address) =>
      this.commitParticipant(transaction!, address),
    ));
    const failedCommit = commitResults.find((result) => result.status === "rejected");
    if (failedCommit !== undefined) {
      const reason = failedCommit.status === "rejected" ? failedCommit.reason : undefined;
      throw new CoordinatorError(503, `participant commit is incomplete: ${errorMessage(reason)}`);
    }

    this.publishCommit(transaction);
    try {
      await this.pruneVersions();
    } catch (error) {
      // Facts, indices, and visibility are already durable. Cleanup failure must
      // not turn a completed commit into a failed write response.
      console.warn("Poneglyph post-commit pruning deferred", errorMessage(error));
    }
    return "committed";
  }

  private async finishCancellation(transaction: TransactionRow): Promise<"aborted"> {
    const participants = this.readParticipantReferences(transaction);
    const results = await Promise.allSettled(participants.map((address) =>
      this.cancelParticipant(transaction, address),
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

  private async preflightParticipants(
    batch: FactBatch,
    payloadHash: string,
    participants: readonly PreparedParticipant[],
    directoryEpoch: number,
  ): Promise<readonly Readonly<{ address: LeafAddress; shouldSplit: boolean; canAdmit: boolean }>[]> {
    const state = this.readGraphState();
    const statementTimeMs = Math.max(Date.now(), state.next_statement_time_ms + 1);
    const results = await Promise.all(participants.map(async (participant) => {
      const result = await this.postShard(participant.address.prefix, "_preflight", {
        graphId: this.readGraphIdentity(),
        shardPrefix: participant.address.prefix,
        shardGeneration: participant.address.generation,
        directoryEpoch,
        txId: batch.txId,
        payloadHash,
        statementTimeMs,
        commitSeq: state.visible_seq + 1,
        facts: participant.facts,
      });
      if (typeof result["shouldSplit"] !== "boolean" || typeof result["canAdmit"] !== "boolean") {
        throw new CoordinatorError(502, "shard returned an invalid capacity preflight result");
      }
      return { address: participant.address, shouldSplit: result["shouldSplit"], canAdmit: result["canAdmit"] };
    }));
    return results;
  }

  private async splitPrefix(prefix: VirtualPrefix, force: boolean): Promise<Response | undefined> {
    const migrationId = this.reserveSplit(prefix, force);
    return this.performSplit(migrationId);
  }

  private async groupBatch(
    batch: FactBatch,
    directoryEpoch: number,
    expectedAddresses?: readonly ParticipantReference[],
  ): Promise<PreparedParticipant[]> {
    const graphId = this.readGraphIdentity();
    const groups = new Map<string, { address: LeafAddress; facts: { index: number; fact: FactDraft; virtualKey: VirtualKey }[] }>();
    for (const [index, fact] of batch.facts.entries()) {
      const virtualKey = await virtualKeyForEntity(graphId, fact.entity);
      const address = expectedAddresses === undefined
        ? (await resolveEntityLeaf(this.env, graphId, fact.entity, directoryEpoch)).address
        : expectedAddresses.find((candidate) => matchesPrefix(virtualKey, candidate.prefix));
      if (address === undefined || !matchesPrefix(virtualKey, address.prefix)) {
        throw new CoordinatorError(500, "transaction facts do not match their persisted shard routes");
      }
      const group = groups.get(address.prefix) ?? { address, facts: [] };
      if (group.address.generation !== address.generation) {
        throw new CoordinatorError(500, "one leaf was assigned inconsistent routing generations");
      }
      group.facts.push({ index, fact: factAsJson(fact), virtualKey });
      groups.set(address.prefix, group);
    }
    return [...groups.values()].sort((left, right) => left.address.prefix < right.address.prefix ? -1 : 1);
  }

  private reserveTransaction(
    batch: FactBatch,
    payloadHash: string,
    batchJson: string,
    participants: readonly PreparedParticipant[],
    directoryEpoch: number,
  ):
    | { kind: "created" }
    | { kind: "busy"; txId: string }
    | { kind: "topology-busy" }
    | { kind: "route-changed" }
    | { kind: "existing"; row: TransactionRow } {
    return this.ctx.storage.transactionSync(() => {
      const existing = this.readTransaction(batch.txId);
      if (existing !== undefined) return { kind: "existing", row: existing };
      const state = this.readGraphState();
      if (state.topology_op_id !== null) return { kind: "topology-busy" };
      if (state.writer_tx_id !== null) return { kind: "busy", txId: state.writer_tx_id };
      if (state.directory_epoch !== directoryEpoch) return { kind: "route-changed" };

      const now = Date.now();
      this.ctx.storage.sql.exec(
        `DELETE FROM graph_transactions WHERE phase IN ('complete', 'aborted') AND created_at_ms < ?`,
        now - TRANSACTION_IDEMPOTENCY_RETENTION_MS,
      );
      const outcomeCount = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM graph_transactions WHERE phase IN ('complete', 'aborted')",
      ).toArray()[0]?.count ?? 0;
      this.ctx.storage.sql.exec("DELETE FROM tree_reservations WHERE phase IN ('complete', 'aborted') AND created_at_ms < ?", now - TRANSACTION_IDEMPOTENCY_RETENTION_MS);
      const external = this.ctx.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM tree_reservations WHERE phase IN ('complete', 'aborted')").one().count;
      if (outcomeCount + external >= TREE_OUTCOME_LIMIT) {
        throw new CoordinatorError(429, `subtree has reached its ${TREE_OUTCOME_LIMIT}-outcome share of the graph window`, false);
      }
      if (this.hasReadLease()) return { kind: "busy", txId: "read-cut" };
      const metadataBytes = new TextEncoder().encode(batchJson).byteLength + participants.length * 96 + 1_024;
      const coordinatorCapacity = accountStorage(this.ctx.storage.sql.databaseSize, {
        factLogBytes: 0,
        activeIndexBytes: 0,
        projectionBytes: 0,
        transactionStagingBytes: metadataBytes,
      });
      if (!coordinatorCapacity.canAdmit) throw new CoordinatorError(413, "coordinator metadata would exceed the per-DO accounted capacity limit");

      if (participants.length === 0 || participants.length > MAX_TRANSACTION_PARTICIPANTS) {
        throw new CoordinatorError(413, `transaction cannot exceed ${MAX_TRANSACTION_PARTICIPANTS} participant leaves`);
      }
      const commitSeq = state.visible_seq + 1;
      const statementTimeMs = Math.max(Date.now(), state.next_statement_time_ms + 1);
      const nextStatementTimeMs = statementTimeMs + batch.facts.length;
      this.ctx.storage.sql.exec(
        `INSERT INTO graph_transactions
         (tx_id, payload_hash, batch_json, participants_json, directory_epoch, statement_time_ms, commit_seq, phase, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'preparing', ?)`,
        batch.txId,
        payloadHash,
        batchJson,
        JSON.stringify(participants.map(({ address }) => address)),
        directoryEpoch,
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
      shardPrefix: participant.address.prefix,
      shardGeneration: participant.address.generation,
      directoryEpoch: transaction.directory_epoch,
      txId: transaction.tx_id,
      payloadHash: transaction.payload_hash,
      statementTimeMs: transaction.statement_time_ms,
      commitSeq: transaction.commit_seq,
      facts: participant.facts,
    };
    await this.callParticipant(participant.address, "_prepare", body);
  }

  private async commitParticipant(transaction: TransactionRow, address: ParticipantReference): Promise<void> {
    await this.callParticipant(address, "_commit", {
      graphId: this.readGraphIdentity(),
      shardPrefix: address.prefix,
      shardGeneration: address.generation,
      directoryEpoch: transaction.directory_epoch,
      txId: transaction.tx_id,
      payloadHash: transaction.payload_hash,
      commitSeq: transaction.commit_seq,
    });
  }

  private async cancelParticipant(transaction: TransactionRow, address: ParticipantReference): Promise<void> {
    await this.callParticipant(address, "_cancel", {
      graphId: this.readGraphIdentity(),
      shardPrefix: address.prefix,
      shardGeneration: address.generation,
      directoryEpoch: transaction.directory_epoch,
      txId: transaction.tx_id,
      payloadHash: transaction.payload_hash,
    });
  }

  private async callParticipant(address: ParticipantReference, path: string, body: unknown): Promise<void> {
    const stub = this.env.GRAPH_SHARDS.getByName(shardObjectName(this.readGraphIdentity(), address.prefix));
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

    const cut = await this.acquireReadCut(graphId);
    const lease = { snapshotSeq: Math.max(...cut.map(s => s.snapshotSeq)), directoryEpoch: 0,
      expiresAtMs: Math.min(...cut.map(s => s.expiresAtMs)) };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("query time budget exceeded", "TimeoutError")), QUERY_TIMEOUT_MS);
    try {
      const source = new DistributedFactSource(this.env, graphId, lease.snapshotSeq, lease.directoryEpoch, lease.expiresAtMs, undefined, cut);
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
        sequenceScope: "subtree-vector",
        snapshotVector: cut.map(s => ({ prefix: s.prefix, sequence: s.snapshotSeq, epoch: s.directoryEpoch })),
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
      await this.releaseReadCut(graphId, cut);
    }
  }

  private async readEntity(request: Request, graphId: GraphId): Promise<Response> {
    const entity = parseUri(new URL(request.url).searchParams.get("uri"), "uri");
    if (!entity.ok) return jsonResponse({ error: entity.error.message }, 400);
    const key = await virtualKeyForEntity(graphId, entity.value);
    const cut = await this.acquireReadCut(graphId);
    const lease = cut.find(s => s.prefix === treeForKey(key))!;
    try {
      const route = await resolveEntityLeaf(this.env, graphId, entity.value, lease.directoryEpoch);
      const stub = this.env.GRAPH_SHARDS.getByName(shardObjectName(graphId, route.address.prefix));
      const response = await stub.fetch("https://shard.internal/_entity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          graphId,
          shardPrefix: route.address.prefix,
          shardGeneration: route.address.generation,
          directoryEpoch: lease.directoryEpoch,
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
      await this.releaseReadCut(graphId, cut);
    }
  }

  private beginReadLease(): ReadLease {
    return this.ctx.storage.transactionSync(() => {
      const state = this.readGraphState();
      if (state.writer_tx_id !== null || state.topology_op_id !== null) throw new CoordinatorError(423, "subtree writer/topology operation is active");
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
        "INSERT INTO graph_read_leases (read_id, snapshot_seq, directory_epoch, expires_at_ms) VALUES (?, ?, ?, ?)",
        readId,
        graph.visible_seq,
        graph.directory_epoch,
        expiresAtMs,
      );
      return { readId, snapshotSeq: graph.visible_seq, directoryEpoch: graph.directory_epoch, expiresAtMs };
    });
  }

  private releaseReadLease(readId: string): Readonly<{ minSnapshotSeq: number; minDirectoryEpoch: number }> {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      this.ctx.storage.sql.exec("DELETE FROM graph_read_leases WHERE read_id = ? OR expires_at_ms <= ?", readId, now);
      const lease = this.ctx.storage.sql.exec<{ min_seq: number | null; min_epoch: number | null }>(
        "SELECT MIN(snapshot_seq) AS min_seq, MIN(directory_epoch) AS min_epoch FROM graph_read_leases WHERE expires_at_ms > ?",
        now,
      ).toArray()[0];
      const state = this.readGraphState();
      return {
        minSnapshotSeq: lease?.min_seq ?? state.visible_seq,
        minDirectoryEpoch: lease?.min_epoch ?? state.directory_epoch,
      };
    });
  }

  private async pruneVersions(minSnapshotSeq?: number, minDirectoryEpoch?: number): Promise<void> {
    const minimum = minSnapshotSeq ?? this.minimumSnapshotSeq();
    const graphId = this.readGraphIdentity();
    const state = this.readGraphState();
    if (state.topology_op_id !== null) return;
    const minimumEpoch = minDirectoryEpoch ?? this.minimumDirectoryEpoch();
    const routes = await listShardLeaves(this.env, graphId, state.directory_epoch, this.treePrefix());
    await Promise.allSettled(routes.leaves.map(async (address) => {
      const stub = this.env.GRAPH_SHARDS.getByName(shardObjectName(graphId, address.prefix));
      const response = await stub.fetch("https://shard.internal/_prune", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          graphId,
          shardPrefix: address.prefix,
          shardGeneration: address.generation,
          directoryEpoch: state.directory_epoch,
          minSnapshotSeq: minimum,
        }),
      });
      if (!response.ok) console.warn("Poneglyph projection pruning deferred", address.prefix, response.status);
    }));
    await this.retireExpiredOwners(graphId, minimumEpoch);
  }

  private async retireExpiredOwners(graphId: GraphId, minimumEpoch: number): Promise<void> {
    const eligible = this.ctx.storage.sql.exec<SplitRow>(
      `SELECT migration_id, source_prefix, source_generation, left_prefix, right_prefix, base_visible_seq,
        old_directory_epoch, split_epoch, phase, force, created_at_ms
       FROM graph_splits WHERE phase = 'cutover' AND split_epoch <= ?`,
      minimumEpoch,
    ).toArray();
    for (const split of eligible) {
      try {
        await this.postShard(split.source_prefix as VirtualPrefix, "_retire", {
          graphId,
          prefix: split.source_prefix,
          migrationId: split.migration_id,
        });
        this.ctx.storage.sql.exec("DELETE FROM graph_splits WHERE migration_id = ? AND phase = 'cutover'", split.migration_id);
      } catch (error) {
        console.warn("Poneglyph old split owner retirement deferred", split.source_prefix, errorMessage(error));
      }
    }
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

  private minimumDirectoryEpoch(): number {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      this.ctx.storage.sql.exec("DELETE FROM graph_read_leases WHERE expires_at_ms <= ?", now);
      const lease = this.ctx.storage.sql.exec<{ min_epoch: number | null }>(
        "SELECT MIN(directory_epoch) AS min_epoch FROM graph_read_leases WHERE expires_at_ms > ?",
        now,
      ).toArray()[0];
      return lease?.min_epoch ?? this.readGraphState().directory_epoch;
    });
  }

  private readGraphState(): GraphStateRow {
    const row = this.ctx.storage.sql.exec<GraphStateRow>(
      "SELECT visible_seq, directory_epoch, writer_tx_id, topology_op_id, next_statement_time_ms FROM graph_state WHERE singleton = 1",
    ).toArray()[0];
    if (row === undefined) throw new CoordinatorError(500, "graph state row is missing");
    return row;
  }

  private readTransaction(txId: string): TransactionRow | undefined {
    return this.ctx.storage.sql.exec<TransactionRow>(
      `SELECT tx_id, payload_hash, batch_json, participants_json, directory_epoch, statement_time_ms,
              commit_seq, phase, created_at_ms
       FROM graph_transactions WHERE tx_id = ?`,
      txId,
    ).toArray()[0];
  }

  private readParticipantReferences(transaction: TransactionRow): readonly ParticipantReference[] {
    let input: unknown;
    try {
      input = JSON.parse(transaction.participants_json) as unknown;
    } catch {
      throw new CoordinatorError(500, "stored participant list is corrupt");
    }
    if (!Array.isArray(input) || input.length === 0 || input.length > MAX_TRANSACTION_PARTICIPANTS) {
      throw new CoordinatorError(500, "stored participant list is invalid");
    }
    const references: ParticipantReference[] = [];
    const prefixes = new Set<string>();
    for (const item of input) {
      if (item === null || typeof item !== "object") throw new CoordinatorError(500, "stored participant address is invalid");
      const record = item as Record<string, unknown>;
      const prefix = parseVirtualPrefix(record["prefix"]);
      const generation = record["generation"];
      if (!prefix.ok || typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0 || prefixes.has(prefix.value)) {
        throw new CoordinatorError(500, "stored participant address is invalid");
      }
      prefixes.add(prefix.value);
      references.push({ prefix: prefix.value, generation });
    }
    return references;
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

  private treePrefix(): VirtualPrefix {
    const row = this.ctx.storage.sql.exec<{prefix: string}>("SELECT prefix FROM tree_context WHERE singleton = 1").toArray()[0];
    const prefix = parseVirtualPrefix(row?.prefix);
    if (!prefix.ok || prefix.value.length !== TREE_DEPTH) throw new CoordinatorError(500, "subtree context is missing");
    return prefix.value;
  }

  private isExternalWriter(txId: string): boolean {
    return this.ctx.storage.sql.exec("SELECT tx_id FROM tree_reservations WHERE tx_id = ? AND phase = 'preparing'", txId).toArray().length > 0;
  }

  private hasReadLease(): boolean {
    return this.ctx.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM graph_read_leases WHERE expires_at_ms > ?", Date.now()).one().count > 0;
  }

  private async treeControl(request: Request): Promise<Response> {
    const raw = await readJsonBody(request, MAX_TRANSACTION_BYTES + 512);
    if (!raw.ok || !isRecord(raw.value)) throw new CoordinatorError(400, "invalid subtree control");
    const body = raw.value;
    const graph = parseGraphId(body["graphId"]), prefix = parseVirtualPrefix(body["prefix"]);
    if (!graph.ok || !prefix.ok || prefix.value.length !== TREE_DEPTH) throw new CoordinatorError(400, "invalid subtree identity");
    if (new URL(request.url).pathname === "/_tree-audit") return jsonResponse({ ...this.readGraphState(),
      phases: this.ctx.storage.sql.exec("SELECT phase, COUNT(*) AS count FROM graph_transactions GROUP BY phase").toArray(),
      reservations: this.ctx.storage.sql.exec("SELECT phase, COUNT(*) AS count FROM tree_reservations GROUP BY phase").toArray(),
      transactions: this.ctx.storage.sql.exec("SELECT tx_id, phase FROM graph_transactions UNION ALL SELECT tx_id, phase FROM tree_reservations").toArray(),
      databaseBytes: this.ctx.storage.sql.databaseSize });
    this.assertGraphIdentity(graph.value);
    this.ctx.storage.transactionSync(() => {
      const prior = this.ctx.storage.sql.exec<{prefix: string}>("SELECT prefix FROM tree_context").toArray()[0];
      if (prior && prior.prefix !== prefix.value) throw new CoordinatorError(409, "subtree object identity mismatch");
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO tree_context (singleton, prefix) VALUES (1, ?)", prefix.value);
    });
    const action = new URL(request.url).pathname;
    if (action === "/_tree-split") return this.requestSplit(new Request("https://tree.internal/_split", {
      method: "POST", body: JSON.stringify({...body, prefix: body["sourcePrefix"]}),
    }));
    if (action === "/_tree-status") return jsonResponse({ ...this.readGraphState(),
      phases: this.ctx.storage.sql.exec("SELECT phase, COUNT(*) AS count FROM graph_transactions GROUP BY phase").toArray(),
      reservations: this.ctx.storage.sql.exec("SELECT phase, COUNT(*) AS count FROM tree_reservations GROUP BY phase").toArray(),
      transactions: this.ctx.storage.sql.exec("SELECT tx_id, phase FROM graph_transactions UNION ALL SELECT tx_id, phase FROM tree_reservations").toArray(),
      databaseBytes: this.ctx.storage.sql.databaseSize });
    if (action === "/_tree-read") return jsonResponse({ prefix: prefix.value, ...this.beginReadLease() });
    if (action === "/_tree-release-read") {
      if (typeof body["readId"] !== "string") throw new CoordinatorError(400, "invalid read ID");
      this.releaseReadLease(body["readId"]); return jsonResponse({ status: "released" });
    }
    if (action === "/_tree-transaction") {
      const batch = parseFactBatch(body["batch"]);
      if (!batch.ok) throw new CoordinatorError(400, "invalid tree batch");
      for (const fact of batch.value.facts) if (treeForKey(await virtualKeyForEntity(graph.value, fact.entity)) !== prefix.value)
        throw new CoordinatorError(409, "transaction escapes its subtree");
      return this.writeTransaction(new Request(`https://tree.internal/v1/graphs/${graph.value}/transactions`, {
        method: "POST", body: canonicalBatchJson(batch.value),
      }), graph.value);
    }
    const txId = body["txId"], hash = body["payloadHash"];
    if (typeof txId !== "string" || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new CoordinatorError(400, "invalid transaction control identity");
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{payload_hash: string; phase: string; commit_seq: number}>("SELECT * FROM tree_reservations WHERE tx_id = ?", txId).toArray()[0];
      if (row && row.payload_hash !== hash) throw new CoordinatorError(409, "tree reservation payload conflict");
      const state = this.readGraphState();
      if (action === "/_tree-lock") {
        if (state.writer_tx_id !== null && state.writer_tx_id !== txId || state.topology_op_id !== null || this.hasReadLease())
          return jsonResponse({ error: "subtree is busy", retryable: true }, 423);
        if (row?.phase === "complete") return jsonResponse({ visibleSeq: state.visible_seq, directoryEpoch: state.directory_epoch });
        if (row?.phase === "aborted") throw new CoordinatorError(409, "reservation was aborted");
        this.ctx.storage.sql.exec("DELETE FROM tree_reservations WHERE phase IN ('complete', 'aborted') AND created_at_ms < ?", Date.now() - TRANSACTION_IDEMPOTENCY_RETENTION_MS);
        this.ctx.storage.sql.exec("DELETE FROM graph_transactions WHERE phase IN ('complete', 'aborted') AND created_at_ms < ?", Date.now() - TRANSACTION_IDEMPOTENCY_RETENTION_MS);
        const count = this.ctx.storage.sql.exec<{count: number}>(`SELECT (SELECT COUNT(*) FROM graph_transactions WHERE phase IN ('complete', 'aborted')) +
          (SELECT COUNT(*) FROM tree_reservations WHERE phase IN ('complete', 'aborted')) AS count`).one().count;
        if (!row && count >= TREE_OUTCOME_LIMIT) throw new CoordinatorError(429, "subtree retained-outcome share is full", false);
        const capacity = accountStorage(this.ctx.storage.sql.databaseSize, { factLogBytes: 0, activeIndexBytes: 0, projectionBytes: 0, transactionStagingBytes: 2048 });
        if (!capacity.canAdmit) throw new CoordinatorError(413, "subtree metadata capacity exceeded");
        this.ctx.storage.sql.exec("INSERT OR IGNORE INTO tree_reservations (tx_id, payload_hash, phase, created_at_ms) VALUES (?, ?, 'preparing', ?)", txId, hash, Date.now());
        this.ctx.storage.sql.exec("UPDATE graph_state SET writer_tx_id = ? WHERE singleton = 1", txId);
        return jsonResponse({ visibleSeq: state.visible_seq, directoryEpoch: state.directory_epoch });
      }
      if (action === "/_tree-unlock") {
        if (state.writer_tx_id === txId) this.ctx.storage.sql.exec("UPDATE graph_state SET writer_tx_id = NULL WHERE singleton = 1");
        if (body["abort"] === true) this.ctx.storage.sql.exec("UPDATE tree_reservations SET phase = 'aborted' WHERE tx_id = ? AND phase = 'preparing'", txId);
        else this.ctx.storage.sql.exec("DELETE FROM tree_reservations WHERE tx_id = ? AND phase = 'preparing'", txId);
        return jsonResponse({ status: "released" });
      }
      if (action === "/_tree-finish") {
        const seq = body["commitSeq"];
        if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) throw new CoordinatorError(400, "invalid publication sequence");
        if (row?.phase === "complete") {
          if (row.commit_seq !== seq) throw new CoordinatorError(409, "publication sequence conflict");
          return jsonResponse({ status: "complete" });
        }
        if (!row || state.writer_tx_id !== txId || seq <= state.visible_seq) throw new CoordinatorError(409, "publication does not own the subtree gate");
        this.ctx.storage.sql.exec("UPDATE tree_reservations SET phase = 'complete', commit_seq = ? WHERE tx_id = ?", seq, txId);
        this.ctx.storage.sql.exec("UPDATE graph_state SET writer_tx_id = NULL, visible_seq = ? WHERE singleton = 1", seq);
        return jsonResponse({ status: "complete" });
      }
      throw new CoordinatorError(404, "unknown tree operation");
    });
  }

  private async acquireReadCut(graphId: GraphId): Promise<TreeSnapshot[]> {
    const cut: TreeSnapshot[] = [];
    try {
      for (const prefix of TREE_PREFIXES) {
        const response = await this.env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graphId, prefix)).fetch("https://tree.internal/_tree-read", {
          method: "POST", body: JSON.stringify({ graphId, prefix }),
        });
        if (!response.ok) throw new CoordinatorError(423, "cannot acquire an atomic subtree read cut");
        cut.push(await response.json() as TreeSnapshot);
      }
      return cut;
    } catch (error) { await this.releaseReadCut(graphId, cut); throw error; }
  }

  private async releaseReadCut(graphId: GraphId, cut: readonly TreeSnapshot[]): Promise<void> {
    await Promise.all(cut.map(async lease => {
      const response = await this.env.GRAPH_COORDINATORS.getByName(treeCoordinatorName(graphId, lease.prefix)).fetch("https://tree.internal/_tree-release-read", {
        method: "POST", body: JSON.stringify({ graphId, prefix: lease.prefix, readId: lease.readId }),
      });
      if (!response.ok) console.warn("subtree read release deferred", lease.prefix);
    }));
  }

  private writerBusy(txId: string): Response {
    return jsonResponse({ error: "another graph transaction is being recovered or committed", txId, retryable: true }, 423, {
      "retry-after": "1",
    });
  }

  private topologyBusy(operationId: string): Response {
    return jsonResponse({ error: "graph topology is being copied or cut over", operationId, retryable: true }, 423, {
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

class ParticipantResponseError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ParticipantResponseError";
  }
}

class CoordinatorError extends Error {
  constructor(readonly status: number, message: string, readonly retryable = status === 423 || status === 429 || status >= 500) {
    super(message);
    this.name = "CoordinatorError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
