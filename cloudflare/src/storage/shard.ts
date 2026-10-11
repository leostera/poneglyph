import { DurableObject } from "cloudflare:workers";
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
  SHARD_COUNT,
  SHARD_SCAN_PAGE_SIZE,
  ROUTING_VERSION,
} from "./constants.js";
import { jsonResponse, readJsonBody } from "./http.js";
import { shardIndexForEntity } from "./keys.js";
import { parseParticipantBatch, parseScanRequest, type ParticipantBatch, type ScanRequest } from "./protocol.js";
import { ensureShardSchema } from "./sql.js";

const ENTITY_TEXT_FIELDS = new Set(["wiki:page:title", "schema:name"]);

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

export class GraphShardDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => ensureShardSchema(ctx.storage));
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
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
      if (shardIndexForEntity(indexedFact.fact.entity) !== batch.value.shardIndex) {
        return jsonResponse({ error: "participant received a fact owned by another shard" }, 409);
      }
    }

    const payloadJson = JSON.stringify(batch.value);
    const outcome = this.ctx.storage.transactionSync(() => {
      this.assertIdentity(batch.value.graphId, batch.value.shardIndex);
      this.validatePreparedBatch(batch.value);
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

      this.ctx.storage.sql.exec(
        `INSERT INTO shard_transactions (tx_id, payload_hash, payload_json, status)
         VALUES (?, ?, ?, 'prepared')`,
        batch.value.txId,
        batch.value.payloadHash,
        payloadJson,
      );
      return "prepared";
    });

    return jsonResponse({ status: outcome });
  }

  private async commit(request: Request): Promise<Response> {
    const control = await this.readControl(request);
    if (!control.ok) return control.response;
    const { graphId, shardIndex, txId, payloadHash, commitSeq } = control.value;
    const result = this.ctx.storage.transactionSync(() => {
      this.assertIdentity(graphId, shardIndex);
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
    const shardIndex = readShardIndex(input.value["shardIndex"]);
    if (!graphId.ok || !txId.ok || !shardIndex.ok || typeof payloadHash !== "string" || !/^[a-f0-9]{64}$/.test(payloadHash)) {
      return jsonResponse({ error: "invalid cancel request" }, 400);
    }

    this.ctx.storage.transactionSync(() => {
      this.assertIdentity(graphId.value, shardIndex.value);
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
          `INSERT INTO shard_transactions (tx_id, payload_hash, payload_json, status)
           VALUES (?, ?, NULL, 'cancelled')`,
          txId.value,
          payloadHash,
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
    this.assertIdentityOutsideTransaction(scan.value.graphId, scan.value.shardIndex);
    if (scan.value.leaseExpiresAtMs <= Date.now()) {
      return jsonResponse({ error: "read snapshot lease expired" }, 410);
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
    const shardIndex = readShardIndex(input.value["shardIndex"]);
    const snapshotSeq = readNonNegativeInteger(input.value["snapshotSeq"]);
    const leaseExpiresAtMs = readNonNegativeInteger(input.value["leaseExpiresAtMs"]);
    if (!graphId.ok || !entity.ok || !shardIndex.ok || !snapshotSeq.ok || !leaseExpiresAtMs.ok) {
      return jsonResponse({ error: "invalid entity read request" }, 400);
    }
    if (shardIndexForEntity(entity.value) !== shardIndex.value) {
      return jsonResponse({ error: "entity is not owned by this shard" }, 409);
    }
    this.assertShardIdentity(graphId.value, shardIndex.value);
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
    const shardIndex = readShardIndex(input.value["shardIndex"]);
    const minSnapshotSeq = readNonNegativeInteger(input.value["minSnapshotSeq"]);
    if (!graphId.ok || !shardIndex.ok || !minSnapshotSeq.ok) return jsonResponse({ error: "invalid prune request" }, 400);

    this.ctx.storage.transactionSync(() => {
      this.assertIdentity(graphId.value, shardIndex.value);
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
      if (!entity.ok || shardIndexForEntity(entity.value) !== scan.shardIndex) {
        return { sql: "SELECT entity, fact_id, value_index, datalog_type, datalog_value FROM active_values WHERE 0", args: [] };
      }
      clauses.push("entity = ?");
      args.push(entity.value);
    }

    if (scan.value !== undefined) {
      const factValue = datalogValueToFactValue(scan.field, scan.value);
      if (factValue === undefined) {
        return { sql: "SELECT entity, fact_id, value_index, datalog_type, datalog_value FROM active_values WHERE 0", args: [] };
      }
      clauses.push("value_key = ?");
      args.push(JSON.stringify(factValue));
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

      const factId = `poneglyph:fact:${encodeURIComponent(batch.graphId)}:${encodeURIComponent(batch.txId)}:${indexed.index}`;
      const parsedFactId = parseFactId(factId);
      if (!parsedFactId.ok) throw new ShardProtocolError(500, "could not construct a fact ID");
      const statedAt = new Date(batch.statementTimeMs + indexed.index).toISOString();

      this.ctx.storage.sql.exec(
        `INSERT INTO fact_log (fact_id, tx_id, source, entity, field, value_json, retraction, stated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        parsedFactId.value,
        batch.txId,
        fact.source,
        fact.entity,
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
       (source, entity, field, value_json, fact_id, tx_id, stated_at, valid_from_seq, valid_to_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      fact.source,
      fact.entity,
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
         (fact_id, value_index, source, entity, field, datalog_type, datalog_value, value_key, value_json,
          tx_id, stated_at, valid_from_seq, valid_to_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        factId,
        valueIndex,
        fact.source,
        fact.entity,
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

  private updateEntityProjection(batch: ParticipantBatch, facts: readonly { index: number; fact: import("../domain/fact.js").FactDraft }[], entity: string): void {
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
      `INSERT INTO entity_versions (entity, fields_json, last_tx_id, valid_from_seq, valid_to_seq)
       VALUES (?, ?, ?, ?, NULL)`,
      entity,
      fieldsJson,
      batch.txId,
      batch.commitSeq,
    );
  }

  private async readControl(request: Request): Promise<
    | { ok: true; value: Readonly<{ graphId: string; shardIndex: number; txId: string; payloadHash: string; commitSeq: number }> }
    | { ok: false; response: Response }
  > {
    const input = await readJsonBody(request, 4_096);
    if (!input.ok || !isRecord(input.value)) {
      return { ok: false, response: jsonResponse({ error: input.ok ? "expected a commit object" : input.error.message }, 400) };
    }
    const graphId = parseGraphId(input.value["graphId"]);
    const shardIndex = readShardIndex(input.value["shardIndex"]);
    const txId = parseTransactionId(input.value["txId"]);
    const payloadHash = input.value["payloadHash"];
    const commitSeq = readPositiveInteger(input.value["commitSeq"]);
    if (!graphId.ok || !shardIndex.ok || !txId.ok || !commitSeq.ok || typeof payloadHash !== "string" || !/^[a-f0-9]{64}$/.test(payloadHash)) {
      return { ok: false, response: jsonResponse({ error: "invalid commit request" }, 400) };
    }
    return {
      ok: true,
      value: { graphId: graphId.value, shardIndex: shardIndex.value, txId: txId.value, payloadHash, commitSeq: commitSeq.value },
    };
  }

  private assertIdentityOutsideTransaction(graphId: string, shardIndex: number): void {
    this.ctx.storage.transactionSync(() => this.assertIdentity(graphId, shardIndex));
  }

  private assertShardIdentity(graphId: string, shardIndex: number): void {
    this.assertIdentityOutsideTransaction(graphId, shardIndex);
  }

  private assertIdentity(graphId: string, shardIndex: number): void {
    const row = this.ctx.storage.sql.exec<{
      graph_id: string;
      shard_index: number;
      routing_version: number;
    }>("SELECT graph_id, shard_index, routing_version FROM shard_identity WHERE singleton = 1").toArray()[0];
    if (row === undefined) {
      this.ctx.storage.sql.exec(
        `INSERT INTO shard_identity (singleton, graph_id, shard_index, routing_version)
         VALUES (1, ?, ?, ?)`,
        graphId,
        shardIndex,
        ROUTING_VERSION,
      );
      return;
    }
    if (row.graph_id !== graphId || row.shard_index !== shardIndex || row.routing_version !== ROUTING_VERSION) {
      throw new ShardProtocolError(409, "Durable Object identity does not match its graph/shard route");
    }
  }
}

function datalogValueToFactValue(field: string, value: DatalogValue): FactValue | undefined {
  if (value.type === "integer") return Object.freeze({ type: "number", value: value.value });
  if (ENTITY_TEXT_FIELDS.has(field)) return Object.freeze({ type: "text", value: value.value });
  const reference = parseUri(value.value);
  return reference.ok
    ? Object.freeze({ type: "reference", value: reference.value })
    : Object.freeze({ type: "text", value: value.value });
}

function readShardIndex(input: unknown): { ok: true; value: number } | { ok: false } {
  return typeof input === "number" && Number.isInteger(input) && input >= 0 && input < SHARD_COUNT
    ? { ok: true, value: input }
    : { ok: false };
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
