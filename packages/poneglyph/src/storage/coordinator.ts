import { DurableObject } from "cloudflare:workers";
import type { StorageEnv as Env } from "./environment.js";
import { parseGraphId, type GraphId } from "../domain/graph-id.js";
import { parseUri, type Uri } from "../domain/identifiers.js";
import { isRecord } from "../domain/result.js";
import { OwnerWrites, OwnerWriteError } from "./owner-writes.js";
import { ensureTreeSchema } from "./sql.js";
import { accountStorage } from "./capacity.js";
import { jsonResponse, readJsonBody } from "./http.js";
import {
  MAX_READ_LEASES, MAX_TRANSACTION_BYTES, MAX_TRANSACTION_FACTS, READ_LEASE_TTL_MS,
  ROUTING_VERSION, TRANSACTION_IDEMPOTENCY_RETENTION_MS,
} from "./constants.js";
import { parseVirtualPrefix, shardObjectName, virtualKeyForEntity, type VirtualPrefix } from "./keys.js";
import { listShardLeaves } from "./routing.js";
import { TREE_DEPTH, TREE_OUTCOME_LIMIT, treeForKey } from "./forest.js";

type GraphStateRow = Readonly<{
  visible_seq: number;
  directory_epoch: number;
  writer_tx_id: string | null;
  topology_op_id: string | null;
  next_statement_time_ms: number;
}>;

type ReadLease = Readonly<{readId: string; snapshotSeq: number; directoryEpoch: number; expiresAtMs: number}>;

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

export class GraphTreeDO extends DurableObject<Env> {
  private activeTopologyOpId: string | undefined;
  private readonly ownerWrites: OwnerWrites;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ownerWrites = new OwnerWrites(ctx.storage);
    void ctx.blockConcurrencyWhile(async () => ensureTreeSchema(ctx.storage));
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path.startsWith("/_tree-")) {
      try { return await this.treeControl(request); }
      catch (error) { const known = error instanceof CoordinatorError || error instanceof OwnerWriteError;
        return jsonResponse({error: errorMessage(error), retryable: known ? error.retryable : true}, known ? error.status : 503); }
    }
    return jsonResponse({error: "not found"}, 404);
  }

  override async alarm(): Promise<void> {}

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
      if (state.writer_tx_id !== null || this.ownerWrites.hasWriters() || this.hasReadLease())
        throw new CoordinatorError(423, "cannot split while entity reservations or read leases are pending");
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

  private beginReadLease(): ReadLease {
    return this.ctx.storage.transactionSync(() => {
      const state = this.readGraphState();
      if (state.writer_tx_id !== null || this.ownerWrites.hasWriters() || state.topology_op_id !== null) throw new CoordinatorError(423, "subtree writer/topology operation is active");
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

  private hasReadLease(): boolean {
    return this.ctx.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM graph_read_leases WHERE expires_at_ms > ?", Date.now()).one().count > 0;
  }

  private async treeControl(request: Request): Promise<Response> {
    const raw = await readJsonBody(request, MAX_TRANSACTION_BYTES + 512);
    if (!raw.ok || !isRecord(raw.value)) throw new CoordinatorError(400, "invalid subtree control");
    const body = raw.value;
    const graph = parseGraphId(body["graphId"]), prefix = parseVirtualPrefix(body["prefix"]);
    if (!graph.ok || !prefix.ok || prefix.value.length !== TREE_DEPTH) throw new CoordinatorError(400, "invalid subtree identity");
    if (new URL(request.url).pathname === "/_tree-audit") return jsonResponse({ ...this.readGraphState(), ...this.ownerWrites.audit(),
      phases: [],
      reservations: this.ctx.storage.sql.exec("SELECT phase, COUNT(*) AS count FROM tree_reservations GROUP BY phase").toArray(),
      transactions: this.ctx.storage.sql.exec("SELECT tx_id, phase FROM tree_reservations").toArray(),
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
    if (action === "/_tree-directory") {
      const state = this.readGraphState();
      return jsonResponse({directoryEpoch: state.directory_epoch, visibleSeq: state.visible_seq});
    }
    if (action === "/_tree-status") return jsonResponse({ ...this.readGraphState(), ...this.ownerWrites.audit(),
      phases: [],
      reservations: this.ctx.storage.sql.exec("SELECT phase, COUNT(*) AS count FROM tree_reservations GROUP BY phase").toArray(),
      transactions: this.ctx.storage.sql.exec("SELECT tx_id, phase FROM tree_reservations").toArray(),
      databaseBytes: this.ctx.storage.sql.databaseSize });
    if (action === "/_tree-read") return jsonResponse({ prefix: prefix.value, ...this.beginReadLease() });
    if (action === "/_tree-release-read") {
      if (typeof body["readId"] !== "string") throw new CoordinatorError(400, "invalid read ID");
      this.releaseReadLease(body["readId"]); return jsonResponse({ status: "released" });
    }
    if (action === "/_tree-transaction") throw new CoordinatorError(404, "coarse local transaction path is not part of G");
    const txId = body["txId"], hash = body["payloadHash"];
    if (typeof txId !== "string" || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new CoordinatorError(400, "invalid transaction control identity");
    const identityTime = body["identityTimeMs"];
    if (typeof identityTime !== "number" || !Number.isSafeInteger(identityTime) || identityTime < 0)
      throw new CoordinatorError(400, "invalid transaction identity anchor");
    if (action === "/_tree-atomic-proof") {
      const seq = body["commitSeq"], epoch = body["directoryEpoch"], decision = body["decision"];
      if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1 ||
          typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0 ||
          decision !== "committed" && decision !== "aborted") throw new CoordinatorError(400, "invalid local authority proof tuple");
      return jsonResponse({authorityReleased: this.ownerWrites.authorityReleased(txId, hash, seq, epoch, identityTime, decision)});
    }
    if (action === "/_tree-lock") {
      const epoch = body["directoryEpoch"];
      if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0) throw new CoordinatorError(400, "invalid provisional directory epoch");
      const rawEntities = body["entities"];
      if (!Array.isArray(rawEntities) || rawEntities.length === 0 || rawEntities.length > MAX_TRANSACTION_FACTS)
        throw new CoordinatorError(400, "invalid owner entity set");
      const entities: Uri[] = [];
      for (const rawEntity of rawEntities) {
        const entity = parseUri(rawEntity);
        if (!entity.ok || treeForKey(await virtualKeyForEntity(graph.value, entity.value)) !== prefix.value)
          throw new CoordinatorError(409, "entity reservation escapes its owner");
        entities.push(entity.value);
      }
      const unique = [...new Set(entities)].sort();
      return jsonResponse(this.ownerWrites.reserve(txId, hash, unique, epoch, identityTime));
    }
    if (action === "/_tree-unlock") {
      this.ownerWrites.release(txId, hash, identityTime, body["abort"] === true);
      return jsonResponse({status: "released"});
    }
    if (action === "/_tree-finish") {
      const seq = body["commitSeq"];
      if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) throw new CoordinatorError(400, "invalid publication sequence");
      this.ownerWrites.publish(txId, hash, seq, identityTime);
      return jsonResponse({status: "complete"});
    }
    throw new CoordinatorError(404, "unknown tree operation");
  }

  private topologyBusy(operationId: string): Response {
    return jsonResponse({ error: "graph topology is being copied or cut over", operationId, retryable: true }, 423, {
      "retry-after": "1",
    });
  }
}

class ParticipantResponseError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "ParticipantResponseError"; }
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
