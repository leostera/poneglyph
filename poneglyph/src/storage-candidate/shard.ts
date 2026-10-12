import { DurableObject } from "cloudflare:workers";
import type { CandidateStorageEnv as Env } from "./environment.js";
import { TREE_DEPTH } from "./forest.js";
import { parseFactValue, type FactValue } from "../domain/fact-value.js";
import { compareUnicodeScalars } from "../domain/string-order.js";
import { parseFactId, parseTransactionId, parseUri } from "../domain/identifiers.js";
import { parseGraphId } from "../domain/graph-id.js";
import { isRecord } from "../domain/result.js";
import { factScalarToDatalogValue, parseDatalogValue } from "../datalog/value.js";
import type { DatalogValue } from "../datalog/value.js";
import {
  MAX_ACTIVE_FACTS_PER_ENTITY,
  MAX_ENTITY_FIELDS,
  MAX_TRANSACTION_BYTES,
  MAX_SQL_BINDINGS,
  TRANSACTION_IDEMPOTENCY_RETENTION_MS,
  SHARD_SCAN_PAGE_SIZE,
  SPLIT_COPY_PAGE_SIZE,
} from "./constants.js";
import { accountStorage, estimateMutationFootprint } from "./capacity.js";
import { MIGRATION_TABLES, migrationRowBytes, parseMigrationTable, virtualKeyRange, type MigrationTable, type MigrationRow } from "./migration.js";
import { jsonResponse, readJsonBody, sha256Hex } from "./http.js";
import { matchesPrefix, parseVirtualKey, parseVirtualPrefix, virtualKeyForEntity, type VirtualPrefix } from "./keys.js";
import { parseParticipantBatch, parseScanRequest, type ParticipantBatch, type ScanRequest } from "./protocol.js";
import { ensureShardSchema } from "./sql.js";

type ActiveFactRow = Readonly<{
  source: string;
  entity: string;
  field: string;
  value_json: string;
  fact_id: string;
}>;

type ActiveValueRow = Readonly<{
  entity: string;
  fact_id: string;
  value_index: number;
  datalog_type: string;
  datalog_value: string;
}>;

type StoredEntityVersion = Readonly<{
  fields_json: string;
  last_tx_id: string;
}>;

type ShardIdentity = Readonly<{
  graph_id: string;
  prefix: string;
  generation: number;
  role: "leaf" | "router";
  split_epoch: number | null;
  child_zero_prefix: string | null;
  child_one_prefix: string | null;
  migration_id: string | null;
  migration_state: "active" | "copying" | "ready" | "retired";
}>;

export class GraphShardDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => ensureShardSchema(ctx.storage));
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (request.method === "POST" && path === "/_route") return await this.route(request);
      if (request.method === "POST" && path === "/_preflight") return await this.preflight(request);
      if (request.method === "POST" && path === "/_begin-split") return await this.beginSplit(request);
      if (request.method === "POST" && path === "/_init-child") return await this.initChild(request);
      if (request.method === "POST" && path === "/_export") return await this.exportPage(request);
      if (request.method === "POST" && path === "/_import") return await this.importPage(request);
      if (request.method === "POST" && path === "/_finish-child") return await this.finishChild(request);
      if (request.method === "POST" && path === "/_cutover") return await this.cutover(request);
      if (request.method === "POST" && path === "/_count") return await this.countRange(request);
      if (request.method === "POST" && path === "/_abort-split") return await this.abortSplit(request);
      if (request.method === "POST" && path === "/_retire") return await this.retire(request);
      if (request.method === "POST" && path === "/_prepare") return await this.prepare(request);
      if (request.method === "POST" && path === "/_commit") return await this.commit(request);
      if (request.method === "POST" && path === "/_cancel") return await this.cancel(request);
      if (request.method === "POST" && path === "/_scan") return await this.scan(request);
      if (request.method === "POST" && path === "/_entity") return await this.getEntity(request);
      if (request.method === "POST" && path === "/_prune") return await this.prune(request);
      return jsonResponse({ error: "not found" }, 404);
    } catch (error) {
      const status = error instanceof ShardProtocolError ? error.status : 500;
      return jsonResponse({ error: errorMessage(error) }, status);
    }
  }

  private async prepare(request: Request): Promise<Response> {
    const input = await readJsonBody(request, MAX_TRANSACTION_BYTES);
    if (!input.ok) return jsonResponse({ error: input.error.message, path: input.error.path }, 400);
    const batch = parseParticipantBatch(input.value);
    if (!batch.ok) return jsonResponse({ error: batch.error.message, path: batch.error.path }, 400);
    for (const indexedFact of batch.value.facts) {
      const actualKey = await virtualKeyForEntity(batch.value.graphId, indexedFact.fact.entity);
      if (actualKey !== indexedFact.virtualKey || !matchesPrefix(actualKey, batch.value.shardPrefix)) {
        return jsonResponse({ error: "participant received a fact outside its virtual-shard range" }, 409);
      }
    }

    const payloadJson = JSON.stringify(batch.value);
    const outcome = this.ctx.storage.transactionSync(() => {
      this.assertWritableIdentity(batch.value.graphId, batch.value.shardPrefix, batch.value.shardGeneration);
      this.ctx.storage.sql.exec(
        `DELETE FROM shard_transactions WHERE status IN ('committed', 'cancelled') AND created_at_ms < ?`,
        Date.now() - TRANSACTION_IDEMPOTENCY_RETENTION_MS,
      );
      const existing = this.ctx.storage.sql.exec<{
        payload_hash: string;
        status: string;
      }>("SELECT payload_hash, status FROM shard_transactions WHERE tx_id = ?", batch.value.txId).toArray()[0];

      if (existing !== undefined) {
        if (existing.payload_hash !== batch.value.payloadHash) {
          throw new ShardProtocolError(409, "transaction ID was already used with a different participant payload");
        }
        if (existing.status === "cancelled") {
          throw new ShardProtocolError(409, "transaction was cancelled");
        }
        return existing.status;
      }

      // Replay is decided from the durable outcome, not the now-changed fact state
      // or another capacity reservation for the same transaction.
      this.validatePreparedBatch(batch.value);
      this.assertCapacity(batch.value.facts.map((indexed) => indexed.fact));
      this.ctx.storage.sql.exec(
        `INSERT INTO shard_transactions (tx_id, payload_hash, payload_json, status, created_at_ms)
         VALUES (?, ?, ?, 'prepared', ?)`,
        batch.value.txId,
        batch.value.payloadHash,
        payloadJson,
        Date.now(),
      );
      return "prepared";
    });

    return jsonResponse({ status: outcome });
  }

  private async commit(request: Request): Promise<Response> {
    const control = await this.readControl(request);
    if (!control.ok) return control.response;
    const { graphId, shardPrefix, shardGeneration, txId, payloadHash, commitSeq } = control.value;
    const result = this.ctx.storage.transactionSync(() => {
      this.assertWritableIdentity(graphId, shardPrefix, shardGeneration);
      const row = this.ctx.storage.sql.exec<{
        payload_hash: string;
        payload_json: string | null;
        status: string;
      }>("SELECT payload_hash, payload_json, status FROM shard_transactions WHERE tx_id = ?", txId).toArray()[0];
      if (row === undefined) throw new ShardProtocolError(409, "transaction was not prepared on this shard");
      if (row.payload_hash !== payloadHash) throw new ShardProtocolError(409, "participant payload hash mismatch");
      if (row.status === "committed") return "committed";
      if (row.status !== "prepared" || row.payload_json === null) {
        throw new ShardProtocolError(409, "transaction is not in the prepared state");
      }

      const parsed = parseParticipantBatch(JSON.parse(row.payload_json) as unknown);
      if (!parsed.ok) throw new ShardProtocolError(500, `stored prepare record is invalid: ${parsed.error.message}`);
      if (parsed.value.commitSeq !== commitSeq) throw new ShardProtocolError(409, "commit sequence mismatch");
      this.applyParticipantBatch(parsed.value);
      this.ctx.storage.sql.exec(
        `UPDATE shard_transactions SET payload_json = NULL, status = 'committed' WHERE tx_id = ?`,
        txId,
      );
      return "committed";
    });

    return jsonResponse({ status: result, txId, commitSeq });
  }

  private async cancel(request: Request): Promise<Response> {
    const input = await readJsonBody(request, 4_096);
    if (!input.ok || !isRecord(input.value)) {
      return jsonResponse({ error: input.ok ? "expected a cancel object" : input.error.message }, 400);
    }
    const graphId = parseGraphId(input.value["graphId"]);
    const txId = parseTransactionId(input.value["txId"]);
    const payloadHash = input.value["payloadHash"];
    const shardPrefix = parseVirtualPrefix(input.value["shardPrefix"]);
    const shardGeneration = readNonNegativeInteger(input.value["shardGeneration"]);
    if (!graphId.ok || !txId.ok || !shardPrefix.ok || !shardGeneration.ok || typeof payloadHash !== "string" || !/^[a-f0-9]{64}$/.test(payloadHash)) {
      return jsonResponse({ error: "invalid cancel request" }, 400);
    }

    this.ctx.storage.transactionSync(() => {
      this.assertWritableIdentity(graphId.value, shardPrefix.value, shardGeneration.value);
      const row = this.ctx.storage.sql.exec<{
        payload_hash: string;
        status: string;
      }>("SELECT payload_hash, status FROM shard_transactions WHERE tx_id = ?", txId.value).toArray()[0];
      if (row !== undefined && row.payload_hash !== payloadHash) {
        throw new ShardProtocolError(409, "participant payload hash mismatch");
      }
      if (row?.status === "committed") throw new ShardProtocolError(409, "committed transaction cannot be cancelled");
      if (row?.status === "cancelled") return;
      if (row === undefined) {
        this.ctx.storage.sql.exec(
          `INSERT INTO shard_transactions (tx_id, payload_hash, payload_json, status, created_at_ms)
           VALUES (?, ?, NULL, 'cancelled', ?)`,
          txId.value,
          payloadHash,
          Date.now(),
        );
      } else {
        this.ctx.storage.sql.exec(
          `UPDATE shard_transactions SET payload_json = NULL, status = 'cancelled' WHERE tx_id = ?`,
          txId.value,
        );
      }
    });
    return jsonResponse({ status: "cancelled", txId: txId.value });
  }

  private async scan(request: Request): Promise<Response> {
    const input = await readJsonBody(request, 16_384);
    if (!input.ok) return jsonResponse({ error: input.error.message }, 400);
    const scan = parseScanRequest(input.value);
    if (!scan.ok) return jsonResponse({ error: scan.error.message, path: scan.error.path }, 400);
    this.assertReadableIdentity(scan.value.graphId, scan.value.shardPrefix, scan.value.shardGeneration, scan.value.directoryEpoch);
    if (scan.value.leaseExpiresAtMs <= Date.now()) {
      return jsonResponse({ error: "read snapshot lease expired" }, 410);
    }

    if (scan.value.entity?.type === "string") {
      const parsedEntity = parseUri(scan.value.entity.value);
      if (!parsedEntity.ok || !matchesPrefix(await virtualKeyForEntity(scan.value.graphId, parsedEntity.value), scan.value.shardPrefix)) {
        return jsonResponse({ error: "entity is outside the requested virtual-shard range" }, 409);
      }
    }
    const prepared = this.prepareScan(scan.value);
    const encoder = new TextEncoder();
    let cursor: Readonly<{ entity: string; factId: string; valueIndex: number }> | undefined;
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (closed) return;
        if (scan.value.leaseExpiresAtMs <= Date.now()) {
          closed = true;
          controller.error(new ShardProtocolError(410, "read snapshot lease expired"));
          return;
        }
        const cursorClause = cursor === undefined
          ? ""
          : " AND (entity > ? OR (entity = ? AND fact_id > ?) OR (entity = ? AND fact_id = ? AND value_index > ?))";
        const cursorArgs: (string | number)[] = cursor === undefined
          ? []
          : [cursor.entity, cursor.entity, cursor.factId, cursor.entity, cursor.factId, cursor.valueIndex];
        const rows = this.ctx.storage.sql.exec<ActiveValueRow>(
          `${prepared.sql}${cursorClause} ORDER BY entity, fact_id, value_index LIMIT ?`,
          ...prepared.args,
          ...cursorArgs,
          SHARD_SCAN_PAGE_SIZE,
        ).toArray();
        if (rows.length === 0) {
          closed = true;
          controller.close();
          return;
        }
        const lastRow = rows.at(-1);
        if (lastRow !== undefined) cursor = { entity: lastRow.entity, factId: lastRow.fact_id, valueIndex: lastRow.value_index };
        const chunk = rows.map((row) => {
          const value = parseDatalogValue({ type: row.datalog_type, value: row.datalog_value });
          if (!value.ok) throw new ShardProtocolError(500, "stored Datalog tuple is corrupt");
          return JSON.stringify({ entity: row.entity, value: value.value }) + "\n";
        }).join("");
        controller.enqueue(encoder.encode(chunk));
      },
      cancel: () => { closed = true; },
    });

    return new Response(body, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  private async getEntity(request: Request): Promise<Response> {
    const input = await readJsonBody(request, 4_096);
    if (!input.ok || !isRecord(input.value)) {
      return jsonResponse({ error: input.ok ? "expected an entity read object" : input.error.message }, 400);
    }
    const graphId = parseGraphId(input.value["graphId"]);
    const entity = parseUri(input.value["entity"], "entity");
    const shardPrefix = parseVirtualPrefix(input.value["shardPrefix"]);
    const shardGeneration = readNonNegativeInteger(input.value["shardGeneration"]);
    const directoryEpoch = readNonNegativeInteger(input.value["directoryEpoch"]);
    const snapshotSeq = readNonNegativeInteger(input.value["snapshotSeq"]);
    const leaseExpiresAtMs = readNonNegativeInteger(input.value["leaseExpiresAtMs"]);
    if (!graphId.ok || !entity.ok || !shardPrefix.ok || !shardGeneration.ok || !directoryEpoch.ok || !snapshotSeq.ok || !leaseExpiresAtMs.ok) {
      return jsonResponse({ error: "invalid entity read request" }, 400);
    }
    if (!matchesPrefix(await virtualKeyForEntity(graphId.value, entity.value), shardPrefix.value)) {
      return jsonResponse({ error: "entity is not owned by this shard" }, 409);
    }
    this.assertReadableIdentity(graphId.value, shardPrefix.value, shardGeneration.value, directoryEpoch.value);
    if (leaseExpiresAtMs.value <= Date.now()) return jsonResponse({ error: "read snapshot lease expired" }, 410);

    const row = this.ctx.storage.sql.exec<StoredEntityVersion>(
      `SELECT fields_json, last_tx_id FROM entity_versions
       WHERE entity = ? AND valid_from_seq <= ? AND (valid_to_seq IS NULL OR valid_to_seq > ?)
       ORDER BY valid_from_seq DESC LIMIT 1`,
      entity.value,
      snapshotSeq.value,
      snapshotSeq.value,
    ).toArray()[0];
    if (row === undefined) return jsonResponse({ error: "entity not found" }, 404);

    return jsonResponse({
      uri: entity.value,
      namespace: new URL(entity.value).protocol.slice(0, -1),
      kind: new URL(entity.value).pathname.split(":")[0] ?? "",
      fields: JSON.parse(row.fields_json) as unknown,
      lastProcessedTxId: row.last_tx_id,
      snapshotSeq: snapshotSeq.value,
    });
  }

  private async prune(request: Request): Promise<Response> {
    const input = await readJsonBody(request, 4_096);
    if (!input.ok || !isRecord(input.value)) {
      return jsonResponse({ error: input.ok ? "expected a prune request object" : input.error.message }, 400);
    }
    const graphId = parseGraphId(input.value["graphId"]);
    const shardPrefix = parseVirtualPrefix(input.value["shardPrefix"]);
    const shardGeneration = readNonNegativeInteger(input.value["shardGeneration"]);
    const minSnapshotSeq = readNonNegativeInteger(input.value["minSnapshotSeq"]);
    if (!graphId.ok || !shardPrefix.ok || !shardGeneration.ok || !minSnapshotSeq.ok) return jsonResponse({ error: "invalid prune request" }, 400);

    this.ctx.storage.transactionSync(() => {
      this.assertWritableIdentity(graphId.value, shardPrefix.value, shardGeneration.value);
      this.ctx.storage.sql.exec(
        "DELETE FROM active_values WHERE valid_to_seq IS NOT NULL AND valid_to_seq <= ?",
        minSnapshotSeq.value,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM active_facts WHERE valid_to_seq IS NOT NULL AND valid_to_seq <= ?",
        minSnapshotSeq.value,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM entity_versions WHERE valid_to_seq IS NOT NULL AND valid_to_seq <= ?",
        minSnapshotSeq.value,
      );
    });
    return jsonResponse({ status: "pruned", minSnapshotSeq: minSnapshotSeq.value });
  }

  private prepareScan(scan: ScanRequest): Readonly<{ sql: string; args: readonly (string | number)[] }> {
    const clauses = [
      "field = ?",
      "valid_from_seq <= ?",
      "(valid_to_seq IS NULL OR valid_to_seq > ?)",
    ];
    const args: (string | number)[] = [scan.field, scan.snapshotSeq, scan.snapshotSeq];

    if (scan.entity !== undefined) {
      if (scan.entity.type !== "string") return { sql: "SELECT entity, fact_id, value_index, datalog_type, datalog_value FROM active_values WHERE 0", args: [] };
      const entity = parseUri(scan.entity.value);
      if (!entity.ok) {
        return { sql: "SELECT entity, fact_id, value_index, datalog_type, datalog_value FROM active_values WHERE 0", args: [] };
      }
      clauses.push("entity = ?");
      args.push(entity.value);
    }

    if (scan.value !== undefined) {
      // Datalog conversion is many-to-one: strings also encode references,
      // booleans, dates and collections. Compare the exposed typed value;
      // guessing an original FactValue silently loses valid bound matches.
      clauses.push("datalog_type = ?", "datalog_value = ?");
      args.push(scan.value.type, scan.value.value);
    }

    return {
      sql: `SELECT entity, fact_id, value_index, datalog_type, datalog_value FROM active_values WHERE ${clauses.join(" AND ")}`,
      args,
    };
  }

  private validatePreparedBatch(batch: ParticipantBatch): void {
    const factsByEntity = new Map<string, ParticipantBatch["facts"][number][]>();
    for (const indexed of batch.facts) {
      const facts = factsByEntity.get(indexed.fact.entity) ?? [];
      facts.push(indexed);
      factsByEntity.set(indexed.fact.entity, facts);
    }

    for (const [entity, facts] of factsByEntity) {
      const activeRows = this.ctx.storage.sql.exec<{
        source: string;
        field: string;
        value_json: string;
      }>(
        `SELECT source, field, value_json FROM active_facts
         WHERE entity = ? AND valid_to_seq IS NULL`,
        entity,
      ).toArray();
      const activeKeys = new Set(activeRows.map((row) => JSON.stringify([row.source, row.field, row.value_json])));
      const currentProjection = this.ctx.storage.sql.exec<StoredEntityVersion>(
        `SELECT fields_json, last_tx_id FROM entity_versions
         WHERE entity = ? AND valid_to_seq IS NULL LIMIT 1`,
        entity,
      ).toArray()[0];
      const projectedFields = this.readProjectionFields(currentProjection?.fields_json);

      for (const indexed of facts.sort((left, right) => left.index - right.index)) {
        const fact = indexed.fact;
        const valueJson = JSON.stringify(fact.value);
        const activeKey = JSON.stringify([fact.source, fact.field, valueJson]);
        if (fact.retraction) {
          if (!activeKeys.delete(activeKey)) {
            throw new ShardProtocolError(422, `cannot retract an inactive fact tuple for entity ${entity}`);
          }
          const projected = projectedFields.get(fact.field);
          if (projected !== undefined && JSON.stringify(projected) === valueJson) projectedFields.delete(fact.field);
        } else {
          activeKeys.add(activeKey);
          projectedFields.set(fact.field, fact.value);
        }

        if (activeKeys.size > MAX_ACTIVE_FACTS_PER_ENTITY) {
          throw new ShardProtocolError(413, `entity ${entity} exceeds ${MAX_ACTIVE_FACTS_PER_ENTITY} active fact tuples`);
        }
        if (projectedFields.size > MAX_ENTITY_FIELDS) {
          throw new ShardProtocolError(413, `entity ${entity} exceeds ${MAX_ENTITY_FIELDS} projected fields`);
        }
      }
    }
  }

  private readProjectionFields(fieldsJson: string | undefined): Map<string, FactValue> {
    const fields = new Map<string, FactValue>();
    if (fieldsJson === undefined) return fields;
    const raw: unknown = JSON.parse(fieldsJson);
    if (!isRecord(raw)) throw new ShardProtocolError(500, "stored entity projection is corrupt");
    for (const [field, inputValue] of Object.entries(raw)) {
      const value = parseFactValue(inputValue, `entity.fields.${field}`);
      if (!value.ok) throw new ShardProtocolError(500, "stored entity projection is corrupt");
      fields.set(field, value.value);
    }
    return fields;
  }

  private applyParticipantBatch(batch: ParticipantBatch): void {
    const affectedEntities = new Set<string>();
    const facts = [...batch.facts].sort((left, right) => left.index - right.index);

    for (const indexed of facts) {
      const fact = indexed.fact;
      affectedEntities.add(fact.entity);
      const valueJson = JSON.stringify(fact.value);
      const current = this.ctx.storage.sql.exec<ActiveFactRow>(
        `SELECT source, entity, field, value_json, fact_id FROM active_facts
         WHERE source = ? AND entity = ? AND field = ? AND value_json = ? AND valid_to_seq IS NULL
         LIMIT 1`,
        fact.source,
        fact.entity,
        fact.field,
        valueJson,
      ).toArray()[0];

      // commitSeq keeps fact IDs unique when a txId is reused after its idempotency window expires.
      const factId = `poneglyph:fact:${encodeURIComponent(batch.graphId)}:${encodeURIComponent(batch.txId)}:${batch.commitSeq}:${indexed.index}`;
      const parsedFactId = parseFactId(factId);
      if (!parsedFactId.ok) throw new ShardProtocolError(500, "could not construct a fact ID");
      const statedAt = new Date(batch.statementTimeMs + indexed.index).toISOString();

      this.ctx.storage.sql.exec(
        `INSERT INTO fact_log (fact_id, tx_id, tx_index, commit_seq, source, entity, entity_hash, field, value_json, retraction, stated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        parsedFactId.value,
        batch.txId,
        indexed.index,
        batch.commitSeq,
        fact.source,
        fact.entity,
        indexed.virtualKey,
        fact.field,
        valueJson,
        fact.retraction ? 1 : 0,
        statedAt,
      );

      if (current !== undefined) this.closeActiveFact(current.fact_id, batch.commitSeq);
      if (!fact.retraction) this.insertActiveFact(batch, indexed, parsedFactId.value, statedAt, valueJson);
    }

    for (const entity of affectedEntities) this.updateEntityProjection(batch, facts, entity);
  }

  private closeActiveFact(factId: string, commitSeq: number): void {
    this.ctx.storage.sql.exec(
      "UPDATE active_facts SET valid_to_seq = ? WHERE fact_id = ? AND valid_to_seq IS NULL",
      commitSeq,
      factId,
    );
    this.ctx.storage.sql.exec(
      "UPDATE active_values SET valid_to_seq = ? WHERE fact_id = ? AND valid_to_seq IS NULL",
      commitSeq,
      factId,
    );
  }

  private insertActiveFact(
    batch: ParticipantBatch,
    indexed: ParticipantBatch["facts"][number],
    factId: string,
    statedAt: string,
    valueJson: string,
  ): void {
    const fact = indexed.fact;
    this.ctx.storage.sql.exec(
      `INSERT INTO active_facts
       (source, entity, entity_hash, field, value_json, fact_id, tx_id, stated_at, valid_from_seq, valid_to_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      fact.source,
      fact.entity,
      indexed.virtualKey,
      fact.field,
      valueJson,
      factId,
      batch.txId,
      statedAt,
      batch.commitSeq,
    );

    const values = fact.value.type === "list" ? fact.value.value : [fact.value];
    for (const [valueIndex, item] of values.entries()) {
      const datalog = factScalarToDatalogValue(item);
      const itemJson = JSON.stringify(item);
      this.ctx.storage.sql.exec(
        `INSERT INTO active_values
         (fact_id, value_index, source, entity, entity_hash, field, datalog_type, datalog_value, value_key, value_json,
          tx_id, stated_at, valid_from_seq, valid_to_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        factId,
        valueIndex,
        fact.source,
        fact.entity,
        indexed.virtualKey,
        fact.field,
        datalog.type,
        datalog.value,
        itemJson,
        itemJson,
        batch.txId,
        statedAt,
        batch.commitSeq,
      );
    }
  }

  private updateEntityProjection(batch: ParticipantBatch, facts: readonly ParticipantBatch["facts"][number][], entity: string): void {
    const existing = this.ctx.storage.sql.exec<StoredEntityVersion>(
      `SELECT fields_json, last_tx_id FROM entity_versions WHERE entity = ? AND valid_to_seq IS NULL LIMIT 1`,
      entity,
    ).toArray()[0];
    const fields = new Map<string, FactValue>();
    if (existing !== undefined) {
      const raw: unknown = JSON.parse(existing.fields_json);
      if (!isRecord(raw)) throw new ShardProtocolError(500, "stored entity projection is corrupt");
      for (const [field, inputValue] of Object.entries(raw)) {
        const value = parseFactValue(inputValue, `entity.fields.${field}`);
        if (!value.ok) throw new ShardProtocolError(500, "stored entity projection is corrupt");
        fields.set(field, value.value);
      }
    }

    for (const indexed of facts) {
      const fact = indexed.fact;
      if (fact.entity !== entity) continue;
      if (fact.retraction) {
        const current = fields.get(fact.field);
        if (current !== undefined && JSON.stringify(current) === JSON.stringify(fact.value)) fields.delete(fact.field);
      } else {
        fields.set(fact.field, fact.value);
      }
    }

    if (existing !== undefined) {
      this.ctx.storage.sql.exec(
        "UPDATE entity_versions SET valid_to_seq = ? WHERE entity = ? AND valid_to_seq IS NULL",
        batch.commitSeq,
        entity,
      );
    }
    if (fields.size === 0) return;

    const fieldsJson = JSON.stringify(Object.fromEntries(
      [...fields.entries()].sort(([left], [right]) => compareUnicodeScalars(left, right)),
    ));
    this.ctx.storage.sql.exec(
      `INSERT INTO entity_versions (entity, entity_hash, fields_json, last_tx_id, valid_from_seq, valid_to_seq)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      entity,
      facts.find((indexed) => indexed.fact.entity === entity)?.virtualKey ?? "",
      fieldsJson,
      batch.txId,
      batch.commitSeq,
    );
  }

  private async readControl(request: Request): Promise<
    | { ok: true; value: Readonly<{
        graphId: string;
        shardPrefix: VirtualPrefix;
        shardGeneration: number;
        directoryEpoch: number;
        txId: string;
        payloadHash: string;
        commitSeq: number;
      }> }
    | { ok: false; response: Response }
  > {
    const input = await readJsonBody(request, 4_096);
    if (!input.ok || !isRecord(input.value)) {
      return { ok: false, response: jsonResponse({ error: input.ok ? "expected a commit object" : input.error.message }, 400) };
    }
    const graphId = parseGraphId(input.value["graphId"]);
    const shardPrefix = parseVirtualPrefix(input.value["shardPrefix"]);
    const shardGeneration = readNonNegativeInteger(input.value["shardGeneration"]);
    const directoryEpoch = readNonNegativeInteger(input.value["directoryEpoch"]);
    const txId = parseTransactionId(input.value["txId"]);
    const payloadHash = input.value["payloadHash"];
    const commitSeq = readPositiveInteger(input.value["commitSeq"]);
    if (!graphId.ok || !shardPrefix.ok || !shardGeneration.ok || !directoryEpoch.ok || !txId.ok || !commitSeq.ok || typeof payloadHash !== "string" || !/^[a-f0-9]{64}$/.test(payloadHash)) {
      return { ok: false, response: jsonResponse({ error: "invalid commit request" }, 400) };
    }
    return {
      ok: true,
      value: {
        graphId: graphId.value,
        shardPrefix: shardPrefix.value,
        shardGeneration: shardGeneration.value,
        directoryEpoch: directoryEpoch.value,
        txId: txId.value,
        payloadHash,
        commitSeq: commitSeq.value,
      },
    };
  }

  private async route(request: Request): Promise<Response> {
    const input = await readJsonBody(request, 4_096);
    if (!input.ok || !isRecord(input.value)) return jsonResponse({ error: "invalid directory route request" }, 400);
    const graphId = parseGraphId(input.value["graphId"]);
    const prefix = parseVirtualPrefix(input.value["prefix"]);
    const epoch = readNonNegativeInteger(input.value["directoryEpoch"]);
    if (!graphId.ok || !prefix.ok || !epoch.ok) return jsonResponse({ error: "invalid directory route identity" }, 400);
    if (prefix.value.length < TREE_DEPTH) return jsonResponse({ kind: "router", prefix: prefix.value,
      generation: 0, splitEpoch: 0, children: [`${prefix.value}0`, `${prefix.value}1`], retired: false });
    const identity = this.ctx.storage.transactionSync(() => this.assertIdentity(graphId.value, prefix.value));
    if (identity.role === "leaf") return jsonResponse({ kind: "leaf", prefix: identity.prefix, generation: identity.generation });
    if (identity.split_epoch === null || identity.child_zero_prefix === null || identity.child_one_prefix === null) {
      throw new ShardProtocolError(500, "router node has incomplete child metadata");
    }
    return jsonResponse({
      kind: "router",
      prefix: identity.prefix,
      generation: identity.generation,
      splitEpoch: identity.split_epoch,
      children: [identity.child_zero_prefix, identity.child_one_prefix],
      retired: identity.migration_state === "retired",
    });
  }

  private async beginSplit(request: Request): Promise<Response> {
    const input = await readJsonBody(request, 8_192);
    if (!input.ok || !isRecord(input.value)) return jsonResponse({ error: "invalid split request" }, 400);
    const graphId = parseGraphId(input.value["graphId"]);
    const prefix = parseVirtualPrefix(input.value["prefix"]);
    const generation = readNonNegativeInteger(input.value["generation"]);
    const migrationId = input.value["migrationId"];
    const splitEpoch = readPositiveInteger(input.value["splitEpoch"]);
    const left = parseVirtualPrefix(input.value["leftPrefix"]);
    const right = parseVirtualPrefix(input.value["rightPrefix"]);
    const force = input.value["force"] === true;
    if (!graphId.ok || !prefix.ok || !generation.ok || typeof migrationId !== "string" || !splitEpoch.ok || !left.ok || !right.ok ||
        left.value !== `${prefix.value}0` || right.value !== `${prefix.value}1`) {
      return jsonResponse({ error: "invalid split identity or children" }, 400);
    }

    const outcome = this.ctx.storage.transactionSync(() => {
      const identity = this.assertIdentity(graphId.value, prefix.value);
      if (identity.role === "router" && identity.migration_id === migrationId) {
        return { status: "already-cut-over", leftReservedBytes: 0, rightReservedBytes: 0 };
      }
      if (identity.role !== "leaf" || identity.generation !== generation.value) {
        throw new ShardProtocolError(409, "split source route is stale");
      }
      if (identity.migration_id !== null && identity.migration_id !== migrationId) {
        throw new ShardProtocolError(423, "another migration already owns this source leaf");
      }
      const leftUsage = this.estimateRange(left.value);
      const rightUsage = this.estimateRange(right.value);
      const emptyFootprint = { factLogBytes: 0, activeIndexBytes: 0, projectionBytes: 0, transactionStagingBytes: 0 };
      if (!accountStorage(0, emptyFootprint, leftUsage.reservedBytes).canAdmit ||
          !accountStorage(0, emptyFootprint, rightUsage.reservedBytes).canAdmit) {
        return { status: "capacity-limit", leftReservedBytes: leftUsage.reservedBytes, rightReservedBytes: rightUsage.reservedBytes };
      }
      const distinctKeys = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(DISTINCT entity_hash) AS count FROM fact_log",
      ).toArray()[0]?.count ?? 0;
      const sourceRowCount = leftUsage.rowCount + rightUsage.rowCount;
      const reachedVirtualKeyLimit = prefix.value.length >= 256;
      const hasNoMovableRows = sourceRowCount === 0;
      const hasOnlyOneEntityKey = distinctKeys <= 1 && sourceRowCount > 0;
      if (!force && (reachedVirtualKeyLimit || hasNoMovableRows || hasOnlyOneEntityKey)) {
        return { status: "no-progress", leftReservedBytes: leftUsage.reservedBytes, rightReservedBytes: rightUsage.reservedBytes };
      }
      this.ctx.storage.sql.exec(
        `UPDATE shard_identity SET migration_id = ?, migration_state = 'copying', split_epoch = ?,
          child_zero_prefix = ?, child_one_prefix = ? WHERE singleton = 1`,
        migrationId,
        splitEpoch.value,
        left.value,
        right.value,
      );
      return { status: "copying", leftReservedBytes: leftUsage.reservedBytes, rightReservedBytes: rightUsage.reservedBytes };
    });
    return jsonResponse(outcome);
  }

  private async initChild(request: Request): Promise<Response> {
    const input = await readJsonBody(request, 8_192);
    if (!input.ok || !isRecord(input.value)) return jsonResponse({ error: "invalid child initialization request" }, 400);
    const graphId = parseGraphId(input.value["graphId"]);
    const prefix = parseVirtualPrefix(input.value["prefix"]);
    const migrationId = input.value["migrationId"];
    const reservedBytes = readNonNegativeInteger(input.value["reservedBytes"]);
    if (!graphId.ok || !prefix.ok || typeof migrationId !== "string" || !reservedBytes.ok) return jsonResponse({ error: "invalid child initialization identity" }, 400);
    this.ctx.storage.transactionSync(() => {
      const identity = this.assertIdentity(graphId.value, prefix.value);
      if (identity.role !== "leaf" || identity.migration_id !== null && identity.migration_id !== migrationId) {
        throw new ShardProtocolError(409, "child Durable Object is already assigned to another route or migration");
      }
      const pending = { factLogBytes: 0, activeIndexBytes: 0, projectionBytes: 0, transactionStagingBytes: 0 };
      const importedPageCount = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM migration_import_pages WHERE migration_id = ?",
        migrationId,
      ).toArray()[0]?.count ?? 0;
      const currentReservation = this.ctx.storage.sql.exec<{ migration_reserved_bytes: number }>(
        "SELECT migration_reserved_bytes FROM shard_accounting WHERE singleton = 1",
      ).toArray()[0]?.migration_reserved_bytes ?? 0;
      const nextReservation = importedPageCount > 0 ? currentReservation : reservedBytes.value;
      const capacity = accountStorage(this.ctx.storage.sql.databaseSize, pending, nextReservation);
      if (!capacity.canAdmit) throw new ShardProtocolError(413, "child migration reservation exceeds its per-DO capacity budget");
      this.ctx.storage.sql.exec(
        "UPDATE shard_identity SET migration_id = ?, migration_state = 'copying' WHERE singleton = 1",
        migrationId,
      );
      this.ctx.storage.sql.exec(
        "UPDATE shard_accounting SET migration_reserved_bytes = ? WHERE singleton = 1",
        nextReservation,
      );
    });
    return jsonResponse({ status: "ready-to-import" });
  }

  private async exportPage(request: Request): Promise<Response> {
    const input = await readJsonBody(request, 8_192);
    if (!input.ok || !isRecord(input.value)) return jsonResponse({ error: "invalid export page request" }, 400);
    const graphId = parseGraphId(input.value["graphId"]);
    const sourcePrefix = parseVirtualPrefix(input.value["sourcePrefix"]);
    const targetPrefix = parseVirtualPrefix(input.value["targetPrefix"]);
    const migrationId = input.value["migrationId"];
    const table = parseMigrationTable(input.value["table"]);
    const pageNumber = readNonNegativeInteger(input.value["pageNumber"]);
    const afterRowId = readNonNegativeInteger(input.value["afterRowId"]);
    if (!graphId.ok || !sourcePrefix.ok || !targetPrefix.ok || typeof migrationId !== "string" || table === undefined || !pageNumber.ok || !afterRowId.ok) {
      return jsonResponse({ error: "invalid export cursor" }, 400);
    }
    const source = this.ctx.storage.sql.exec<ShardIdentity>(
      "SELECT graph_id, prefix, generation, role, split_epoch, child_zero_prefix, child_one_prefix, migration_id, migration_state FROM shard_identity WHERE singleton = 1",
    ).toArray()[0];
    if (source?.graph_id !== graphId.value || source.prefix !== sourcePrefix.value || source.migration_id !== migrationId || source.migration_state !== "copying") {
      return jsonResponse({ error: "source is not fenced for this migration" }, 409);
    }
    if (targetPrefix.value !== source.child_zero_prefix && targetPrefix.value !== source.child_one_prefix) {
      return jsonResponse({ error: "target range is not a child of this split" }, 409);
    }
    const [lower, upper] = virtualKeyRange(targetPrefix.value);
    const columns = MIGRATION_TABLES[table];
    const selected = this.ctx.storage.sql.exec<Record<string, null | number | string> & { copy_row_id: number }>(
      `SELECT rowid AS copy_row_id, ${columns.join(", ")} FROM ${table}
       WHERE entity_hash BETWEEN ? AND ? AND rowid > ? ORDER BY rowid LIMIT ?`,
      lower,
      upper,
      afterRowId.value,
      SPLIT_COPY_PAGE_SIZE,
    ).toArray();
    const rows: MigrationRow[] = [];
    let lastRowId = afterRowId.value;
    let serializedBytes = 0;
    for (const selectedRow of selected) {
      const row: Record<string, null | number | string> = {};
      for (const column of columns) {
        row[column] = selectedRow[column] ?? null;
      }
      const rowBytes = new TextEncoder().encode(JSON.stringify(row)).byteLength;
      if (rows.length > 0 && serializedBytes + rowBytes > 1_500_000) break;
      if (rowBytes > 1_500_000) throw new ShardProtocolError(413, "one stored row exceeds the bounded split-page size");
      rows.push(row);
      serializedBytes += rowBytes;
      lastRowId = selectedRow.copy_row_id;
    }
    const hasMore = selected.length === SPLIT_COPY_PAGE_SIZE || rows.length < selected.length;
    return jsonResponse({
      migrationId,
      table,
      targetPrefix: targetPrefix.value,
      pageNumber: pageNumber.value,
      afterRowId: afterRowId.value,
      nextRowId: lastRowId,
      hasMore,
      pageHash: await sha256Hex(JSON.stringify(rows)),
      rows,
    });
  }

  private async importPage(request: Request): Promise<Response> {
    const input = await readJsonBody(request, 2_000_000);
    if (!input.ok || !isRecord(input.value)) return jsonResponse({ error: "invalid migration page" }, 400);
    const graphId = parseGraphId(input.value["graphId"]);
    const targetPrefix = parseVirtualPrefix(input.value["targetPrefix"]);
    const migrationId = input.value["migrationId"];
    const table = parseMigrationTable(input.value["table"]);
    const pageNumber = readNonNegativeInteger(input.value["pageNumber"]);
    const pageHash = input.value["pageHash"];
    const inputRows = input.value["rows"];
    if (!graphId.ok || !targetPrefix.ok || typeof migrationId !== "string" || table === undefined || !pageNumber.ok ||
        typeof pageHash !== "string" || !/^[a-f0-9]{64}$/.test(pageHash) || !Array.isArray(inputRows)) {
      return jsonResponse({ error: "invalid migration page identity" }, 400);
    }
    const rows: MigrationRow[] = [];
    const columns = MIGRATION_TABLES[table];
    for (const [index, inputRow] of inputRows.entries()) {
      if (!isRecord(inputRow) || Object.keys(inputRow).length !== columns.length) return jsonResponse({ error: `invalid migration row ${index}` }, 400);
      const row: Record<string, null | number | string> = {};
      for (const column of columns) {
        const value = inputRow[column];
        if (value !== null && typeof value !== "number" && typeof value !== "string") return jsonResponse({ error: `invalid ${column} in migration row` }, 400);
        row[column] = value as null | number | string;
      }
      const key = parseVirtualKey(row["entity_hash"]);
      if (!key.ok || !matchesPrefix(key.value, targetPrefix.value)) return jsonResponse({ error: "migration row is outside its target range" }, 409);
      rows.push(row);
    }
    if (await sha256Hex(JSON.stringify(rows)) !== pageHash) return jsonResponse({ error: "migration page digest mismatch" }, 409);
    const serializedBytes = migrationRowBytes(rows);
    const growthEstimate = serializedBytes * 3;
    const result = this.ctx.storage.transactionSync(() => {
      const identity = this.assertIdentity(graphId.value, targetPrefix.value);
      if (identity.role !== "leaf" || identity.migration_id !== migrationId || identity.migration_state !== "copying") {
        throw new ShardProtocolError(409, "target is not initialized for this migration");
      }
      const receipt = this.ctx.storage.sql.exec<{ page_hash: string }>(
        `SELECT page_hash FROM migration_import_pages
         WHERE migration_id = ? AND table_name = ? AND target_prefix = ? AND page_number = ?`,
        migrationId,
        table,
        targetPrefix.value,
        pageNumber.value,
      ).toArray()[0];
      if (receipt !== undefined) {
        if (receipt.page_hash !== pageHash) throw new ShardProtocolError(409, "migration page number was replayed with different contents");
        return "duplicate";
      }
      const reserved = this.ctx.storage.sql.exec<{ migration_reserved_bytes: number }>(
        "SELECT migration_reserved_bytes FROM shard_accounting WHERE singleton = 1",
      ).toArray()[0]?.migration_reserved_bytes ?? 0;
      const nextReserve = Math.max(0, reserved - growthEstimate);
      const capacity = accountStorage(this.ctx.storage.sql.databaseSize, {
        factLogBytes: serializedBytes,
        activeIndexBytes: serializedBytes * 2,
        projectionBytes: 0,
        transactionStagingBytes: 0,
      }, nextReserve);
      if (!capacity.canAdmit) throw new ShardProtocolError(413, "migration page would exceed the target's accounted capacity limit");
      const placeholders = columns.map(() => "?").join(", ");
      const insertSql = `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;
      for (const row of rows) this.ctx.storage.sql.exec(insertSql, ...columns.map((column) => row[column]));
      this.ctx.storage.sql.exec(
        `INSERT INTO migration_import_pages (migration_id, table_name, target_prefix, page_number, page_hash, row_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
        migrationId,
        table,
        targetPrefix.value,
        pageNumber.value,
        pageHash,
        rows.length,
      );
      this.ctx.storage.sql.exec("UPDATE shard_accounting SET migration_reserved_bytes = ? WHERE singleton = 1", nextReserve);
      return "imported";
    });
    return jsonResponse({ status: result, rowCount: rows.length });
  }

  private async finishChild(request: Request): Promise<Response> {
    const input = await readJsonBody(request, 4_096);
    if (!input.ok || !isRecord(input.value)) return jsonResponse({ error: "invalid child finalize request" }, 400);
    const graphId = parseGraphId(input.value["graphId"]);
    const prefix = parseVirtualPrefix(input.value["prefix"]);
    const migrationId = input.value["migrationId"];
    if (!graphId.ok || !prefix.ok || typeof migrationId !== "string") return jsonResponse({ error: "invalid child finalize identity" }, 400);
    this.ctx.storage.transactionSync(() => {
      const identity = this.assertIdentity(graphId.value, prefix.value);
      if (identity.migration_id !== migrationId || identity.role !== "leaf") throw new ShardProtocolError(409, "child migration identity mismatch");
      this.ctx.storage.sql.exec("UPDATE shard_identity SET migration_state = 'active', migration_id = NULL WHERE singleton = 1",);
      this.ctx.storage.sql.exec("UPDATE shard_accounting SET migration_reserved_bytes = 0 WHERE singleton = 1");
    });
    return jsonResponse({ status: "active" });
  }

  private async cutover(request: Request): Promise<Response> {
    const input = await readJsonBody(request, 8_192);
    if (!input.ok || !isRecord(input.value)) return jsonResponse({ error: "invalid cutover request" }, 400);
    const graphId = parseGraphId(input.value["graphId"]);
    const prefix = parseVirtualPrefix(input.value["prefix"]);
    const generation = readNonNegativeInteger(input.value["generation"]);
    const migrationId = input.value["migrationId"];
    const splitEpoch = readPositiveInteger(input.value["splitEpoch"]);
    const left = parseVirtualPrefix(input.value["leftPrefix"]);
    const right = parseVirtualPrefix(input.value["rightPrefix"]);
    if (!graphId.ok || !prefix.ok || !generation.ok || typeof migrationId !== "string" || !splitEpoch.ok || !left.ok || !right.ok) {
      return jsonResponse({ error: "invalid cutover identity" }, 400);
    }
    this.ctx.storage.transactionSync(() => {
      const identity = this.assertIdentity(graphId.value, prefix.value);
      if (identity.role === "router" && identity.migration_id === migrationId && identity.split_epoch === splitEpoch.value) return;
      if (identity.role !== "leaf" || identity.generation !== generation.value || identity.migration_id !== migrationId || identity.migration_state !== "copying") {
        throw new ShardProtocolError(409, "source is not ready for cutover");
      }
      this.ctx.storage.sql.exec(
        `UPDATE shard_identity SET role = 'router', generation = generation + 1, migration_state = 'ready',
          split_epoch = ?, child_zero_prefix = ?, child_one_prefix = ? WHERE singleton = 1`,
        splitEpoch.value,
        left.value,
        right.value,
      );
    });
    return jsonResponse({ status: "cut-over", splitEpoch: splitEpoch.value });
  }

  private async countRange(request: Request): Promise<Response> {
    const input = await readJsonBody(request, 4_096);
    if (!input.ok || !isRecord(input.value)) return jsonResponse({ error: "invalid migration count request" }, 400);
    const graphId = parseGraphId(input.value["graphId"]);
    const nodePrefix = parseVirtualPrefix(input.value["nodePrefix"]);
    const rangePrefix = parseVirtualPrefix(input.value["rangePrefix"]);
    const table = parseMigrationTable(input.value["table"]);
    if (!graphId.ok || !nodePrefix.ok || !rangePrefix.ok || table === undefined) return jsonResponse({ error: "invalid count range" }, 400);
    this.ctx.storage.transactionSync(() => this.assertIdentity(graphId.value, nodePrefix.value));
    const [lower, upper] = virtualKeyRange(rangePrefix.value);
    const count = this.ctx.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table} WHERE entity_hash BETWEEN ? AND ?`,
      lower,
      upper,
    ).toArray()[0]?.count ?? 0;
    return jsonResponse({ count });
  }

  private async abortSplit(request: Request): Promise<Response> {
    const input = await readJsonBody(request, 4_096);
    if (!input.ok || !isRecord(input.value)) return jsonResponse({ error: "invalid split abort request" }, 400);
    const graphId = parseGraphId(input.value["graphId"]);
    const prefix = parseVirtualPrefix(input.value["prefix"]);
    const migrationId = input.value["migrationId"];
    if (!graphId.ok || !prefix.ok || typeof migrationId !== "string") return jsonResponse({ error: "invalid split abort identity" }, 400);
    this.ctx.storage.transactionSync(() => {
      const identity = this.assertIdentity(graphId.value, prefix.value);
      if (identity.role === "router") throw new ShardProtocolError(409, "a published split cannot be rolled back");
      if (identity.migration_id !== migrationId) return;
      this.ctx.storage.sql.exec(
        `UPDATE shard_identity SET migration_id = NULL, migration_state = 'active', split_epoch = NULL,
          child_zero_prefix = NULL, child_one_prefix = NULL WHERE singleton = 1`,
      );
    });
    return jsonResponse({ status: "active" });
  }

  private async retire(request: Request): Promise<Response> {
    const input = await readJsonBody(request, 4_096);
    if (!input.ok || !isRecord(input.value)) return jsonResponse({ error: "invalid retirement request" }, 400);
    const graphId = parseGraphId(input.value["graphId"]);
    const prefix = parseVirtualPrefix(input.value["prefix"]);
    const migrationId = input.value["migrationId"];
    if (!graphId.ok || !prefix.ok || typeof migrationId !== "string") return jsonResponse({ error: "invalid retirement identity" }, 400);
    this.ctx.storage.transactionSync(() => {
      const identity = this.assertIdentity(graphId.value, prefix.value);
      if (identity.role !== "router" || identity.migration_id !== migrationId) throw new ShardProtocolError(409, "router migration identity mismatch");
      if (identity.migration_state === "retired") return;
      for (const table of Object.keys(MIGRATION_TABLES) as MigrationTable[]) this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
      this.ctx.storage.sql.exec("DELETE FROM shard_transactions");
      this.ctx.storage.sql.exec("DELETE FROM migration_import_pages");
      this.ctx.storage.sql.exec("UPDATE shard_identity SET migration_state = 'retired' WHERE singleton = 1");
    });
    return jsonResponse({ status: "retired" });
  }

  private estimateRange(prefix: VirtualPrefix): Readonly<{ rowCount: number; reservedBytes: number }> {
    const [lower, upper] = virtualKeyRange(prefix);
    let rowCount = 0;
    let payloadBytes = 0;
    for (const table of Object.keys(MIGRATION_TABLES) as MigrationTable[]) {
      const columns = MIGRATION_TABLES[table];
      const lengths = columns.map((column) => `COALESCE(LENGTH(CAST(${column} AS BLOB)), 0)`).join(" + ");
      const aggregate = this.ctx.storage.sql.exec<{ rows: number; bytes: number }>(
        `SELECT COUNT(*) AS rows, COALESCE(SUM(${lengths} + 256), 0) AS bytes FROM ${table}
         WHERE entity_hash BETWEEN ? AND ?`,
        lower,
        upper,
      ).toArray()[0];
      rowCount += aggregate?.rows ?? 0;
      payloadBytes += aggregate?.bytes ?? 0;
    }
    return { rowCount, reservedBytes: Math.ceil(payloadBytes * 3) + 1_000_000 };
  }

  private async preflight(request: Request): Promise<Response> {
    const input = await readJsonBody(request, MAX_TRANSACTION_BYTES);
    if (!input.ok) return jsonResponse({ error: input.error.message }, 400);
    const batch = parseParticipantBatch(input.value);
    if (!batch.ok) return jsonResponse({ error: batch.error.message }, 400);
    for (const indexed of batch.value.facts) {
      const key = await virtualKeyForEntity(batch.value.graphId, indexed.fact.entity);
      if (key !== indexed.virtualKey || !matchesPrefix(key, batch.value.shardPrefix)) {
        return jsonResponse({ error: "preflight facts do not belong to this shard range" }, 409);
      }
    }
    const identity = this.ctx.storage.transactionSync(() => this.assertIdentity(batch.value.graphId, batch.value.shardPrefix));
    if (identity.role !== "leaf" || identity.generation !== batch.value.shardGeneration || identity.migration_state !== "active") {
      return jsonResponse({ error: "shard route is stale or topology is moving" }, 409);
    }
    return jsonResponse(this.capacityFor(batch.value.facts.map((indexed) => indexed.fact)));
  }

  private assertWritableIdentity(graphId: string, prefix: VirtualPrefix, generation: number): void {
    const identity = this.assertIdentity(graphId, prefix);
    if (identity.role !== "leaf" || identity.generation !== generation || identity.migration_state !== "active") {
      throw new ShardProtocolError(409, "shard is not the active writable owner for this route");
    }
  }

  private assertReadableIdentity(graphId: string, prefix: VirtualPrefix, generation: number, epoch: number): void {
    const identity = this.assertIdentity(graphId, prefix);
    if (identity.role === "leaf" && identity.generation === generation) return;
    if (identity.role === "router" && identity.split_epoch !== null && epoch < identity.split_epoch &&
        generation === identity.generation - 1 && identity.migration_state !== "retired") return;
    throw new ShardProtocolError(409, "shard is not the readable owner for the requested directory epoch");
  }

  private assertIdentity(graphId: string, prefix: VirtualPrefix): ShardIdentity {
    const row = this.ctx.storage.sql.exec<ShardIdentity>(
      `SELECT graph_id, prefix, generation, role, split_epoch, child_zero_prefix, child_one_prefix, migration_id, migration_state
       FROM shard_identity WHERE singleton = 1`,
    ).toArray()[0];
    if (row === undefined) {
      this.ctx.storage.sql.exec(
        `INSERT INTO shard_identity (singleton, graph_id, prefix, generation, role, split_epoch,
          child_zero_prefix, child_one_prefix, migration_id, migration_state)
         VALUES (1, ?, ?, 0, 'leaf', NULL, NULL, NULL, NULL, 'active')`,
        graphId,
        prefix,
      );
      return {
        graph_id: graphId,
        prefix,
        generation: 0,
        role: "leaf",
        split_epoch: null,
        child_zero_prefix: null,
        child_one_prefix: null,
        migration_id: null,
        migration_state: "active",
      };
    }
    if (row.graph_id !== graphId || row.prefix !== prefix) {
      throw new ShardProtocolError(409, "Durable Object identity does not match its graph/prefix route");
    }
    return row;
  }

  private capacityFor(facts: readonly import("../domain/fact.js").FactDraft[]): ReturnType<typeof accountStorage> {
    const accounting = this.ctx.storage.sql.exec<{
      migration_reserved_bytes: number;
      synthetic_size_bytes: number;
    }>("SELECT migration_reserved_bytes, synthetic_size_bytes FROM shard_accounting WHERE singleton = 1").toArray()[0];
    const migrationReserve = accounting?.migration_reserved_bytes ?? 0;
    const syntheticSize = accounting?.synthetic_size_bytes ?? 0;
    const entities = [...new Set(facts.map((fact) => fact.entity))];
    const existingProjectionBytes = new Map<string, number>(entities.map((entity) => [entity, 0] as const));
    for (let offset = 0; offset < entities.length; offset += MAX_SQL_BINDINGS) {
      const page = entities.slice(offset, offset + MAX_SQL_BINDINGS);
      const placeholders = page.map(() => "?").join(", ");
      const rows = this.ctx.storage.sql.exec<{ entity: string; bytes: number }>(
        `SELECT entity, LENGTH(CAST(fields_json AS BLOB)) AS bytes FROM entity_versions
         WHERE valid_to_seq IS NULL AND entity IN (${placeholders})`,
        ...page,
      ).toArray();
      for (const row of rows) existingProjectionBytes.set(row.entity, row.bytes);
    }
    return accountStorage(
      this.ctx.storage.sql.databaseSize + syntheticSize,
      estimateMutationFootprint(facts, existingProjectionBytes),
      migrationReserve,
    );
  }

  private assertCapacity(facts: readonly import("../domain/fact.js").FactDraft[]): void {
    const account = this.capacityFor(facts);
    if (!account.canAdmit) throw new ShardProtocolError(413, `per-DO accounted capacity limit exceeded (${account.projectedAccountedBytes} bytes)`);
  }
}

function readNonNegativeInteger(input: unknown): { ok: true; value: number } | { ok: false } {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0
    ? { ok: true, value: input }
    : { ok: false };
}

function readPositiveInteger(input: unknown): { ok: true; value: number } | { ok: false } {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 1
    ? { ok: true, value: input }
    : { ok: false };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ShardProtocolError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ShardProtocolError";
  }
}
