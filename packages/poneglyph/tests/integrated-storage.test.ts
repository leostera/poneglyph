import { runInDurableObject, evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as storage from "../src/storage/implementation.js";
import { treeForKey, treeCoordinatorName, transactionCoordinatorName, tokenLedgerName, TREE_PREFIXES } from "../src/storage/forest.js";
import { virtualKeyForEntity, shardObjectName, bitAt } from "../src/storage/keys.js";
import { auditFactStorage } from "../src/testing/storage-audit.js";
import { sha256Hex, canonicalBatchJson } from "../src/storage/http.js";
import { parseFactBatch } from "../src/domain/fact.js";
import { dispatchInternalTransaction } from "../src/storage/transaction-request.js";
import { MAX_ACCOUNTED_BYTES_PER_DO, MAX_RETAINED_TRANSACTION_OUTCOMES, MAX_TRANSACTION_BYTES, TRANSACTION_IDEMPOTENCY_RETENTION_MS } from "../src/storage/constants.js";
import { BatchCache } from "../src/storage/batch-cache.js";
import { ensureTreeSchema, ensureShardSchema } from "../src/storage/sql.js";

const fact = (entity: string, retraction = false, value = "alive") => ({source: "agent:integrated", entity,
  field: "wiki:person:status", value: {type: "text", value}, retraction});
async function write(graph: string, txId: string, facts: unknown[]) {
  const batch = parseFactBatch({txId, facts});
  if (!batch.ok) return Response.json({error: batch.error.message}, {status: 400});
  return dispatchInternalTransaction(env, graph, batch.value);
}
async function writeStatus(graph: string, txId: string, facts: unknown[]) {
  const response = await write(graph, txId, facts); const body = await response.text();
  return {status: response.status, body};
}
function query(graph: string) {
  return exports.default.fetch(new Request(`https://database.test/v1/graphs/${graph}/query`, {
    method: "POST", body: JSON.stringify({query: "wiki:person:status(Person, Status)"}),
  }));
}
async function fixtures(graph: string) {
  const first = "wiki:person:integrated-first", firstKey = await virtualKeyForEntity(graph, first), root = treeForKey(firstKey);
  let same = "", other = "";
  for (let i = 0; !same || !other; i++) {
    const entity = `wiki:person:integrated-${i}`, key = await virtualKeyForEntity(graph, entity), next = treeForKey(key);
    if (next === root && bitAt(key, 4) !== bitAt(firstKey, 4)) same = entity;
    else if (next !== root) other = entity;
  }
  return {first, same, other, root, otherRoot: treeForKey(await virtualKeyForEntity(graph, other))};
}

async function recover(graph: string, id: string) {
  const ledger = env.GRAPH_LEDGERS.getByName(await transactionCoordinatorName(graph, id));
  await runInDurableObject(ledger, (_instance, state) => state.storage.sql.exec("UPDATE candidate_transactions SET next_recovery_at_ms = 0 WHERE tx_id = ?", id));
  await runDurableObjectAlarm(ledger);
}
async function split(graph: string, prefix: string, stopAfterPages?: number) {
  const response = await env.GRAPH_FACADES.getByName(storage.coordinatorObjectName(graph)).fetch("https://graph.internal/_split", {
    method: "POST", body: JSON.stringify({graphId: graph, prefix, force: true, stopAfterPages}),
  });
  return {status: response.status, body: await response.text()};
}
async function expireAnchor(graph: string, id: string, roots: readonly ReturnType<typeof treeForKey>[]) {
  // Synthetic window fixture: rebind every stored copy consistently. This is
  // not product repair or a measured duration/capacity experiment.
  await runInDurableObject(env.GRAPH_LEDGERS.getByName(await transactionCoordinatorName(graph, id)), (_instance, state) =>
    state.storage.sql.exec("UPDATE candidate_transactions SET created_at_ms = 0, local_witness_json = json_set(local_witness_json, '$.identityTimeMs', 0) WHERE tx_id = ?", id));
  for (const root of roots) {
    await runInDurableObject(env.GRAPH_TREES.getByName(treeCoordinatorName(graph, root)), (_instance, state) => {
      state.storage.sql.exec("UPDATE tree_reservations SET created_at_ms = 0 WHERE tx_id = ?", id);
      state.storage.sql.exec("UPDATE tree_publication_gates SET created_at_ms = 0 WHERE tx_id = ?", id);
    });
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), (_instance, state) =>
      state.storage.sql.exec(`UPDATE shard_transactions SET created_at_ms = 0,
        decision_context_json = json_set(decision_context_json, '$.identityTimeMs', 0),
        payload_json = json_set(payload_json, '$.identityTimeMs', 0) WHERE tx_id = ?`, id));
  }
}

describe("integrated storage authority", () => {
  it("observes active fields and root value tags at an exact leased snapshot vector", async () => {
    const graph = `test-${crypto.randomUUID()}`, entity = "wiki:person:schema-observation";
    const writeFacts = [
      {source: "agent:schema", entity, field: "wiki:observed:text", value: {type: "text", value: "present"}, retraction: false},
      {source: "agent:schema", entity, field: "wiki:observed:number", value: {type: "number", value: "42"}, retraction: false},
      {source: "agent:schema", entity, field: "wiki:observed:list", value: {type: "list", value: [{type: "text", value: "nested"}]}, retraction: false},
    ];
    const writeResponse = await exports.default.fetch(new Request(`https://database.test/v1/graphs/${graph}/transactions`, {
      method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({facts: writeFacts}),
    }));
    expect(writeResponse.status, await writeResponse.clone().text()).toBe(200);
    expect(Object.keys(await writeResponse.json() as Record<string, unknown>)).toEqual(["txId"]);

    const schemaRequest = () => exports.default.fetch(new Request(`https://database.test/v1/graphs/${graph}/schema`, {
      method: "POST", headers: {"content-type": "application/json"}, body: "{}",
    }));
    const first = await schemaRequest();
    expect(first.status).toBe(200);
    const observed = await first.json() as {snapshotSeq: number; sequenceScope: string;
      snapshotVector: readonly {prefix: string; sequence: number; epoch: number}[];
      fields: readonly {field: string; valueTags: readonly string[]}[]};
    expect(observed.sequenceScope).toBe("subtree-vector");
    expect(observed.snapshotVector).toHaveLength(16);
    expect(observed.snapshotVector.filter(owner => owner.sequence > 0)).toHaveLength(1);
    expect(observed.snapshotVector.find(owner => owner.sequence > 0)).toMatchObject({sequence: 1});
    expect(observed.snapshotSeq).toBe(Math.max(...observed.snapshotVector.map(owner => owner.sequence)));
    expect(new Map(observed.fields.map(field => [field.field, field.valueTags]))).toEqual(new Map([
      ["wiki:observed:list", ["list"]], ["wiki:observed:number", ["number"]], ["wiki:observed:text", ["text"]],
    ]));

    const retract = await exports.default.fetch(new Request(`https://database.test/v1/graphs/${graph}/transactions`, {
      method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({facts: [{...writeFacts[0]!, retraction: true}]}),
    }));
    expect(retract.status).toBe(200);
    const afterRetraction = await schemaRequest();
    const remaining = await afterRetraction.json() as typeof observed;
    expect(remaining.fields.map(field => field.field)).toEqual(["wiki:observed:list", "wiki:observed:number"]);
    expect(remaining.snapshotVector.filter(owner => owner.sequence > 0)).toHaveLength(1);
    expect(remaining.snapshotVector.find(owner => owner.sequence > 0)).toMatchObject({sequence: 2});
  });

  it("routes a tokenized public write through coordinator, same-ledger mapping, tree, and shard roles", async () => {
    const graph = `test-${crypto.randomUUID()}`, token = `integration:chain:${crypto.randomUUID()}`;
    const facade = env.GRAPH_FACADES.getByName(storage.coordinatorObjectName(graph));
    let facadeCalls = 0, originalFetch: unknown;
    await runInDurableObject(facade, instance => {
      originalFetch = Reflect.get(instance, "fetch");
      Reflect.set(instance, "fetch", async (request: Request) => {
        if (new URL(request.url).pathname.endsWith("/transactions")) facadeCalls++;
        return (originalFetch as (this: unknown, request: Request) => Promise<Response>).call(instance, request);
      });
    });
    const response = await exports.default.fetch(new Request(`https://database.test/v1/graphs/${graph}/transactions`, {
      method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({clientRequestToken: token, facts: [fact("wiki:person:role-chain")]}),
    }));
    expect(response.status, await response.clone().text()).toBe(200);
    const txId = (await response.json() as {txId: string}).txId;
    await runInDurableObject(facade, instance => Reflect.set(instance, "fetch", originalFetch));
    expect(facadeCalls).toBe(1);

    const ledgerName = await tokenLedgerName(graph, token);
    expect(await transactionCoordinatorName(graph, txId)).toBe(ledgerName);
    const ledger = env.GRAPH_LEDGERS.getByName(ledgerName);
    await runInDurableObject(ledger, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT phase FROM candidate_transactions WHERE tx_id = ?", txId).one())
        .toEqual({phase: "complete"});
      expect(state.storage.sql.exec("SELECT terminal_status FROM client_request_tokens WHERE tx_id = ?", txId).one())
        .toEqual({terminal_status: "committed"});
    });
  });

  it("reconciles durable request-token outcomes and prunes expired missing transactions", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first} = await fixtures(graph);
    const send = async (body: unknown) => exports.default.fetch(new Request(
      `https://database.test/v1/graphs/${graph}/transactions`,
      {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)},
    ));
    expect((await send({txId: "caller:chosen", facts: [fact(first)]})).status).toBe(400);
    const noToken = await send({facts: [fact(first)]});
    expect(noToken.status).toBe(200);
    const noTokenReceipt = await noToken.json() as Record<string, unknown>;
    expect(Object.keys(noTokenReceipt)).toEqual(["txId"]);
    expect(noTokenReceipt["txId"]).toMatch(/^poneglyph:tx:/);
    const parallelTokens: string[] = [];
    let sharedCoordinator = "";
    for (let candidate = 0; parallelTokens.length < 8; candidate += 1) {
      const token = `integration:parallel:${candidate}`;
      const coordinator = await tokenLedgerName(graph, token);
      if (sharedCoordinator === "") sharedCoordinator = coordinator;
      if (coordinator === sharedCoordinator) parallelTokens.push(token);
    }
    const parallelReceipts = await Promise.all(parallelTokens.map(async (clientRequestToken, index) => {
      const response = await send({clientRequestToken, facts: [fact(`wiki:person:parallel-${index}`)]});
      expect(response.status).toBe(200);
      return (await response.json() as {txId: string}).txId;
    }));
    expect(new Set(parallelReceipts).size).toBe(parallelTokens.length);
    const committedToken = "integration:token:committed";
    const committed = await send({clientRequestToken: committedToken, facts: [fact(first)]});
    expect(committed.status).toBe(200);
    const committedTxId = (await committed.json() as {txId: string}).txId;
    const committedCoordinator = env.GRAPH_LEDGERS.getByName(await tokenLedgerName(graph, committedToken));
    let originalStatusFor: unknown;
    await runInDurableObject(committedCoordinator, (instance, state) => {
      expect(state.storage.sql.exec("SELECT terminal_status FROM client_request_tokens WHERE tx_id = ?", committedTxId).one())
        .toEqual({terminal_status: "committed"});
      state.storage.sql.exec("UPDATE client_request_tokens SET terminal_at_ms = NULL, terminal_status = NULL WHERE tx_id = ?", committedTxId);
      const ledger = Reflect.get(instance, "ledger");
      originalStatusFor = Reflect.get(ledger, "statusFor");
      Reflect.set(ledger, "statusFor", async () => ({phase: "missing"}));
    });
    await runDurableObjectAlarm(committedCoordinator);
    await runInDurableObject(committedCoordinator, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT terminal_at_ms, terminal_status FROM client_request_tokens WHERE tx_id = ?", committedTxId).one())
        .toEqual({terminal_at_ms: null, terminal_status: null});
      Reflect.set(Reflect.get(_instance, "ledger"), "statusFor", originalStatusFor);
    });
    await runDurableObjectAlarm(committedCoordinator);
    await runInDurableObject(committedCoordinator, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT terminal_status FROM client_request_tokens WHERE tx_id = ?", committedTxId).one())
        .toEqual({terminal_status: "committed"});
    });

    const oversizedToken = "integration:token:oversized";
    const oversized = await send({clientRequestToken: oversizedToken, facts: [fact(first, false, "x".repeat(MAX_TRANSACTION_BYTES - 100))]});
    expect(oversized.status).toBe(413);
    const correctedPayload = await send({clientRequestToken: oversizedToken, facts: [fact(first)]});
    expect(correctedPayload.status).toBe(200);

    const abortedToken = "integration:token:aborted";
    const abortedTokenHash = await sha256Hex(`${graph}\u0000${abortedToken}`);
    const aborted = await send({clientRequestToken: abortedToken, facts: [fact("wiki:person:never-asserted", true)]});
    expect(aborted.status).toBe(422);
    const abortedCoordinator = env.GRAPH_LEDGERS.getByName(await tokenLedgerName(graph, abortedToken));
    await runInDurableObject(abortedCoordinator, (_instance, state) => {
      state.storage.sql.exec("UPDATE client_request_tokens SET terminal_at_ms = NULL, terminal_status = NULL WHERE token_hash = ?", abortedTokenHash);
    });
    await runDurableObjectAlarm(abortedCoordinator);
    await runInDurableObject(abortedCoordinator, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT terminal_status FROM client_request_tokens WHERE token_hash = ?", abortedTokenHash).one())
        .toEqual({terminal_status: "aborted"});
      state.storage.sql.exec("UPDATE client_request_tokens SET tx_id = ?, created_at_ms = ?, terminal_at_ms = NULL, terminal_status = NULL WHERE token_hash = ?",
        "poneglyph:tx:missing-pending", Date.now() - 1_000, abortedTokenHash);
    });
    await runDurableObjectAlarm(abortedCoordinator);
    await runInDurableObject(abortedCoordinator, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT terminal_at_ms, terminal_status FROM client_request_tokens WHERE token_hash = ?", abortedTokenHash).one())
        .toEqual({terminal_at_ms: null, terminal_status: null});
      state.storage.sql.exec("UPDATE client_request_tokens SET tx_id = ?, created_at_ms = ? WHERE token_hash = ?",
        "poneglyph:tx:missing-expired", Date.now() - TRANSACTION_IDEMPOTENCY_RETENTION_MS - 1, abortedTokenHash);
    });
    await runDurableObjectAlarm(abortedCoordinator);
    await runInDurableObject(abortedCoordinator, (_instance, state) => {
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM client_request_tokens WHERE token_hash = ?", abortedTokenHash).one().count).toBe(0);
    });
  });

  it("fails closed at the request-token bucket retention allocation", async () => {
    const graph = `test-${crypto.randomUUID()}`;
    const token = `integration:capacity:${crypto.randomUUID()}`;
    const tokenHash = await sha256Hex(`${graph}\u0000${token}`);
    const bucket = tokenHash[0]!;
    const coordinator = env.GRAPH_LEDGERS.getByName(await tokenLedgerName(graph, token));
    const bucketLimit = Math.floor(MAX_RETAINED_TRANSACTION_OUTCOMES / 16);
    await runInDurableObject(coordinator, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("INSERT INTO ledger_context VALUES (1, ?, ?)", graph, bucket);
        const now = Date.now();
        state.storage.sql.exec(`INSERT INTO candidate_transactions
          (tx_id, graph_id, payload_hash, batch_json, trees_json, phase, commit_seq, statement_time_ms, created_at_ms, next_recovery_at_ms)
          VALUES ('poneglyph:tx:capacity-ledger', ?, ?, '{}', '[]', 'complete', 1, 1, ?, ?)`, graph, "b".repeat(64), now, now);
        for (let index = 0; index < bucketLimit - 1; index += 1) {
          const retainedHash = `${bucket}${index.toString(16).padStart(63, "0")}`;
          state.storage.sql.exec(`INSERT INTO client_request_tokens
            (token_hash, payload_hash, tx_id, created_at_ms, terminal_at_ms, terminal_status)
            VALUES (?, ?, ?, ?, ?, 'committed')`, retainedHash, "a".repeat(64), `poneglyph:tx:capacity-${index}`, now, now);
        }
      });
    });
    let ledgerTxId = "";
    for (let index = 0; ledgerTxId === ""; index += 1) {
      const candidate = `poneglyph:tx:capacity-probe:${index}`;
      if (await transactionCoordinatorName(graph, candidate) === await tokenLedgerName(graph, token)) ledgerTxId = candidate;
    }
    expect((await write(graph, ledgerTxId, [fact("wiki:person:capacity-probe-ledger")])).status).toBe(429);
    const response = await exports.default.fetch(new Request(`https://database.test/v1/graphs/${graph}/transactions`, {
      method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({clientRequestToken: token, facts: [fact("wiki:person:capacity-probe")]}),
    }));
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({retryable: false});
    await runInDurableObject(coordinator, (_instance, state) => {
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM client_request_tokens").one().count)
        .toBe(bucketLimit - 1);
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM candidate_transactions").one().count).toBe(1);
      expect(state.storage.sql.exec<{count: number}>(
        "SELECT (SELECT COUNT(*) FROM candidate_transactions) + (SELECT COUNT(*) FROM client_request_tokens) AS count",
      ).one().count).toBe(bucketLimit);
      expect(state.storage.sql.exec("SELECT 1 FROM client_request_tokens WHERE token_hash = ?", tokenHash).toArray())
        .toHaveLength(0);
    });
  });

  it("reserves both ledger outcome slots for a token before it creates the journal", async () => {
    const graph = `test-${crypto.randomUUID()}`;
    const token = `integration:capacity-reservation:${crypto.randomUUID()}`;
    const bucket = (await sha256Hex(`${graph}\u0000${token}`))[0]!;
    const ledger = env.GRAPH_LEDGERS.getByName(await tokenLedgerName(graph, token));
    const bucketLimit = Math.floor(MAX_RETAINED_TRANSACTION_OUTCOMES / 16);
    await runInDurableObject(ledger, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("INSERT INTO ledger_context VALUES (1, ?, ?)", graph, bucket);
        const now = Date.now();
        for (let index = 0; index < bucketLimit - 2; index += 1) {
          state.storage.sql.exec(`INSERT INTO candidate_transactions
            (tx_id, graph_id, payload_hash, batch_json, trees_json, phase, commit_seq, statement_time_ms, created_at_ms, next_recovery_at_ms)
            VALUES (?, ?, ?, '{}', '[]', 'complete', 1, 1, ?, ?)`,
          `poneglyph:tx:capacity-reservation:${index}`, graph, "b".repeat(64), now, now);
        }
      });
    });

    const response = await exports.default.fetch(new Request(`https://database.test/v1/graphs/${graph}/transactions`, {
      method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({clientRequestToken: token, facts: [fact("wiki:person:capacity-reserved")]}),
    }));
    expect(response.status).toBe(200);
    const receipt = await response.json() as {txId: string};
    expect(receipt.txId).toMatch(new RegExp(`^poneglyph:tx:token:${bucket}:`));

    let ordinaryTxId = "";
    for (let index = 0; ordinaryTxId === ""; index += 1) {
      const candidate = `poneglyph:tx:capacity-reservation-probe:${index}`;
      if (await transactionCoordinatorName(graph, candidate) === await tokenLedgerName(graph, token)) ordinaryTxId = candidate;
    }
    expect((await write(graph, ordinaryTxId, [fact("wiki:person:capacity-reservation-probe")])).status).toBe(429);
    await runInDurableObject(ledger, (_instance, state) => {
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM candidate_transactions").one().count)
        .toBe(bucketLimit - 1);
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM client_request_tokens").one().count).toBe(1);
      expect(state.storage.sql.exec<{count: number}>(`SELECT
        (SELECT COUNT(*) FROM candidate_transactions)
        + (SELECT COUNT(*) FROM client_request_tokens)
        + (SELECT COUNT(*) FROM client_request_tokens t
           WHERE NOT EXISTS (SELECT 1 FROM candidate_transactions c WHERE c.tx_id = t.tx_id)) AS count`).one().count)
        .toBe(bucketLimit);
      expect(state.storage.sql.exec<{phase: string}>("SELECT phase FROM candidate_transactions WHERE tx_id = ?", receipt.txId).one().phase)
        .toBe("complete");
      expect(state.storage.sql.exec<{terminal_status: string}>("SELECT terminal_status FROM client_request_tokens WHERE tx_id = ?", receipt.txId).one().terminal_status)
        .toBe("committed");
    });
  });

  it("atomically commits complete single-leaf mutations and payload-bound replay", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, same, root} = await fixtures(graph), id = "integrated:atomic";
    expect(await writeStatus(graph, id, [fact(first), fact(same)])).toMatchObject({status: 200});
    expect(await writeStatus(graph, id, [fact(first), fact(same)])).toMatchObject({status: 200});
    expect(await writeStatus(graph, id, [fact(first, false, "changed")])).toMatchObject({status: 409});
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT status, decision_kind, atomic_fact_count, owner_released FROM shard_transactions").one())
        .toMatchObject({status: "committed", decision_kind: "atomic", atomic_fact_count: 2, owner_released: 1});
      const audit = auditFactStorage(state.storage, 0); expect(audit.facts).toHaveLength(2);
      for (const counter of [audit.missingValues, audit.orphanValues, audit.mismatchedValues, audit.mismatchedFacts, audit.mismatchedDatalog])
        expect(counter?.[0]?.["count"]).toBe(0);
      const projections = state.storage.sql.exec<{fields_json: string; last_tx_id: string}>("SELECT fields_json, last_tx_id FROM entity_versions WHERE valid_to_seq IS NULL").toArray();
      expect(projections).toHaveLength(2);
      for (const projection of projections) {
        expect(JSON.parse(projection.fields_json)).toEqual({"wiki:person:status": {type: "text", value: "alive"}});
        expect(projection.last_tx_id).toBe(id);
      }
    });
    const read = await query(graph); expect(read.status).toBe(200);
    expect((await read.json() as {rows: unknown[]}).rows).toHaveLength(2);
    expect(await writeStatus(graph, "integrated:retract", [fact(first, true), fact(same, true)])).toMatchObject({status: 200});
    const empty = await query(graph); expect((await empty.json() as {rows: unknown[]}).rows).toHaveLength(0);
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), (_instance, state) => {
      expect(auditFactStorage(state.storage, 0).facts).toHaveLength(4);
      expect(state.storage.sql.exec("SELECT * FROM entity_versions WHERE valid_to_seq IS NULL").toArray()).toHaveLength(0);
    });
  });

  it("uses pooled distributed authority and owner-local publication for multiple leaves", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, other, root, otherRoot} = await fixtures(graph), id = "integrated:distributed";
    expect(await writeStatus(graph, id, [fact(first), fact(other)])).toMatchObject({status: 200});
    await runInDurableObject(env.GRAPH_LEDGERS.getByName(await transactionCoordinatorName(graph, id)), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT phase, participant_witness, local_witness_json FROM candidate_transactions WHERE tx_id = ?", id).one())
        .toMatchObject({phase: "complete", participant_witness: 1, local_witness_json: null});
      expect(state.storage.sql.exec("SELECT * FROM ledger_context").toArray()).toHaveLength(1);
      const row = state.storage.sql.exec<{plan_json: string}>("SELECT plan_json FROM candidate_transactions WHERE tx_id = ?", id).one();
      expect(row.plan_json).not.toContain('"fact":');
    });
    await runInDurableObject(env.GRAPH_FACADES.getByName(storage.coordinatorObjectName(graph)), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT frontier FROM graph_safe_frontier WHERE singleton = 1").one())
        .toMatchObject({frontier: 1});
      const vector = state.storage.sql.exec<{prefix: string; directory_epoch: number; visible_seq: number}>(
        "SELECT prefix, directory_epoch, visible_seq FROM graph_safe_vector ORDER BY prefix").toArray();
      expect(vector).toHaveLength(16);
      expect(vector.filter(owner => owner.prefix === root || owner.prefix === otherRoot))
        .toEqual([root, otherRoot].sort().map(prefix => ({prefix, directory_epoch: 0, visible_seq: 1})));
    });
    for (const owner of [root, otherRoot]) {
      await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, owner)), (_instance, state) => {
        expect(state.storage.sql.exec("SELECT status, decision_kind, owner_released, reserved_mutation_bytes FROM shard_transactions").one())
          .toMatchObject({status: "committed", decision_kind: "distributed", owner_released: 1, reserved_mutation_bytes: 0});
        expect(auditFactStorage(state.storage, 0).facts).toHaveLength(1);
      });
      await runInDurableObject(env.GRAPH_TREES.getByName(treeCoordinatorName(graph, owner)), (_instance, state) => {
        expect(state.storage.sql.exec("SELECT phase FROM tree_reservations").one()).toMatchObject({phase: "complete"});
        expect(state.storage.sql.exec("SELECT * FROM entity_write_locks").toArray()).toHaveLength(0);
        expect(state.storage.sql.exec("SELECT * FROM tree_publication_gates").toArray()).toHaveLength(0);
        expect(state.storage.sql.exec("SELECT visible_seq FROM graph_state").one()).toMatchObject({visible_seq: 1});
      });
    }
    const read = await query(graph); expect(read.status).toBe(200); expect((await read.json() as {rows: unknown[]}).rows).toHaveLength(2);
  });

  it("keeps owner gates through lost atomic cached-vector publication and recovers idempotently", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, other, root, otherRoot} = await fixtures(graph), id = "integrated:lost-vector-publication";
    const facade = env.GRAPH_FACADES.getByName(storage.coordinatorObjectName(graph));
    let originalFetch: unknown, lost = false;
    await runInDurableObject(facade, instance => {
      originalFetch = Reflect.get(instance, "fetch");
      Reflect.set(instance, "fetch", async (request: Request) => {
        const response = await (originalFetch as (this: unknown, request: Request) => Promise<Response>).call(instance, request);
        if (new URL(request.url).pathname === "/_publish-vector" && !lost) {
          lost = true; await response.text(); return new Response("lost safe-vector reply", {status: 503});
        }
        return response;
      });
    });
    try { expect(await writeStatus(graph, id, [fact(first), fact(other)])).toMatchObject({status: 503}); }
    finally { await runInDurableObject(facade, instance => Reflect.set(instance, "fetch", originalFetch)); }
    expect(lost).toBe(true);
    for (const owner of [root, otherRoot]) await runInDurableObject(env.GRAPH_TREES.getByName(treeCoordinatorName(graph, owner)), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT visible_seq FROM graph_state").one()).toMatchObject({visible_seq: 1});
      expect(state.storage.sql.exec("SELECT * FROM tree_publication_gates").toArray()).toHaveLength(1);
    });
    const committedView = await query(graph); expect(committedView.status).toBe(200);
    expect((await committedView.json() as {rows: unknown[]}).rows).toHaveLength(2);
    await recover(graph, id);
    for (const owner of [root, otherRoot]) await runInDurableObject(env.GRAPH_TREES.getByName(treeCoordinatorName(graph, owner)), (_instance, state) =>
      expect(state.storage.sql.exec("SELECT * FROM tree_publication_gates").toArray()).toHaveLength(0));
    await runInDurableObject(facade, (_instance, state) => expect(state.storage.sql.exec("SELECT frontier FROM graph_safe_frontier").one())
      .toMatchObject({frontier: 1}));
    const read = await query(graph); expect(read.status).toBe(200);
    expect((await read.json() as {rows: unknown[]}).rows).toHaveLength(2);
  });

  it("recovers an owner-publication whose successful reply was lost", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, other, root, otherRoot} = await fixtures(graph), id = "integrated:lost-owner-publication";
    const orderedOwners = [root, otherRoot].sort(), firstOwner = orderedOwners[0]!, secondOwner = orderedOwners[1]!;
    const secondTree = env.GRAPH_TREES.getByName(treeCoordinatorName(graph, secondOwner));
    let originalFetch: unknown, lost = false;
    await runInDurableObject(secondTree, instance => {
      originalFetch = Reflect.get(instance, "fetch");
      Reflect.set(instance, "fetch", async (request: Request) => {
        const response = await (originalFetch as (this: unknown, request: Request) => Promise<Response>).call(instance, request);
        if (new URL(request.url).pathname === "/_tree-finish" && !lost) {
          lost = true; await response.text();
          return new Response(JSON.stringify({error: "injected lost owner-publication reply"}), {status: 503,
            headers: {"content-type": "application/json"}});
        }
        return response;
      });
    });
    try { expect(await writeStatus(graph, id, [fact(first), fact(other)])).toMatchObject({status: 503}); }
    finally { await runInDurableObject(secondTree, instance => Reflect.set(instance, "fetch", originalFetch)); }
    expect(lost).toBe(true);
    for (const owner of [firstOwner, secondOwner]) await runInDurableObject(env.GRAPH_TREES.getByName(treeCoordinatorName(graph, owner)), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT visible_seq FROM graph_state").one()).toMatchObject({visible_seq: 1});
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM tree_publication_gates").one()).toMatchObject({count: 1});
    });
    await runInDurableObject(env.GRAPH_FACADES.getByName(storage.coordinatorObjectName(graph)), (_instance, state) =>
      expect(state.storage.sql.exec("SELECT frontier FROM graph_safe_frontier").one()).toMatchObject({frontier: 0}));
    const oldView = await query(graph); expect(oldView.status).toBe(200);
    expect((await oldView.json() as {rows: unknown[]}).rows).toHaveLength(0);
    await recover(graph, id);
    const read = await query(graph); expect(read.status).toBe(200);
    expect((await read.json() as {rows: unknown[]}).rows).toHaveLength(2);
    for (const owner of [firstOwner, secondOwner]) await runInDurableObject(env.GRAPH_TREES.getByName(treeCoordinatorName(graph, owner)), (_instance, state) =>
      expect(state.storage.sql.exec("SELECT * FROM tree_publication_gates").toArray()).toHaveLength(0));
  });

  it("recovers a partial owner-gate acquisition without exposing participants", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, other, root, otherRoot} = await fixtures(graph), id = "integrated:partial-owner-gates";
    const orderedOwners = [root, otherRoot].sort(), firstOwner = orderedOwners[0]!, secondOwner = orderedOwners[1]!;
    const secondTree = env.GRAPH_TREES.getByName(treeCoordinatorName(graph, secondOwner));
    let originalFetch: unknown, injected = false;
    await runInDurableObject(secondTree, instance => {
      originalFetch = Reflect.get(instance, "fetch");
      Reflect.set(instance, "fetch", async (request: Request) => {
        if (new URL(request.url).pathname === "/_tree-gate" && !injected) {
          injected = true;
          return new Response(JSON.stringify({error: "injected later-owner gate failure"}), {status: 503,
            headers: {"content-type": "application/json"}});
        }
        return (originalFetch as (this: unknown, request: Request) => Promise<Response>).call(instance, request);
      });
    });
    try { expect(await writeStatus(graph, id, [fact(first), fact(other)])).toMatchObject({status: 503}); }
    finally { await runInDurableObject(secondTree, instance => Reflect.set(instance, "fetch", originalFetch)); }
    expect(injected).toBe(true);
    await runInDurableObject(env.GRAPH_TREES.getByName(treeCoordinatorName(graph, firstOwner)), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM tree_publication_gates").one()).toMatchObject({count: 1});
      expect(state.storage.sql.exec("SELECT visible_seq FROM graph_state").one()).toMatchObject({visible_seq: 0});
    });
    await runInDurableObject(secondTree, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM tree_publication_gates").one()).toMatchObject({count: 0});
      expect(state.storage.sql.exec("SELECT visible_seq FROM graph_state").one()).toMatchObject({visible_seq: 0});
    });
    const oldView = await query(graph); expect(oldView.status).toBe(200);
    expect((await oldView.json() as {rows: unknown[]}).rows).toHaveLength(0);
    await recover(graph, id);
    const read = await query(graph); expect(read.status).toBe(200);
    expect((await read.json() as {rows: unknown[]}).rows).toHaveLength(2);
    for (const owner of [firstOwner, secondOwner]) await runInDurableObject(env.GRAPH_TREES.getByName(treeCoordinatorName(graph, owner)), (_instance, state) =>
      expect(state.storage.sql.exec("SELECT * FROM tree_publication_gates").toArray()).toHaveLength(0));
  });

  it("records a sanitized atomic-abort diagnostic and releases all owner fences", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, root} = await fixtures(graph), id = "integrated:invalid-retraction";
    const diagnostics: unknown[][] = [];
    const originalError = console.error;
    console.error = (...values: unknown[]) => { diagnostics.push(values); };
    try {
      expect(await writeStatus(graph, id, [fact(first, true)])).toMatchObject({status: 422});
      expect(await writeStatus(graph, id, [fact(first, true)])).toMatchObject({status: 422});
    } finally { console.error = originalError; }
    expect(diagnostics).toContainEqual([JSON.stringify({event: "poneglyph.transaction.aborted", phase: "atomic",
      reasonCode: "inactive-fact-retraction", rejectionStatus: 422})]);
    expect(JSON.stringify(diagnostics)).not.toContain(first);
    expect(JSON.stringify(diagnostics)).not.toContain(id);
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT status, decision_kind, owner_released FROM shard_transactions").one())
        .toMatchObject({status: "cancelled", decision_kind: "atomic", owner_released: 1});
      expect(auditFactStorage(state.storage, 0).facts).toHaveLength(0);
    });
    await runInDurableObject(env.GRAPH_TREES.getByName(treeCoordinatorName(graph, root)), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT phase FROM tree_reservations WHERE tx_id = ?", id).one()).toMatchObject({phase: "aborted"});
      expect(state.storage.sql.exec("SELECT * FROM tree_publication_gates").toArray()).toHaveLength(0);
    });
    await runInDurableObject(env.GRAPH_FACADES.getByName(storage.coordinatorObjectName(graph)), (_instance, state) =>
      expect(state.storage.sql.exec("SELECT frontier FROM graph_safe_frontier").one()).toMatchObject({frontier: 0}));
    const read = await query(graph); expect(read.status).toBe(200); await read.text();
  });

  it("recovers a lost local decision after real ledger/leaf eviction without duplicate facts", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, root} = await fixtures(graph), id = "integrated:lost-atomic";
    const leaf = env.GRAPH_SHARDS.getByName(shardObjectName(graph, root));
    await runInDurableObject(leaf, async (instance, state) => {
      const atomic = Reflect.get(instance, "atomic");
      Reflect.set(instance, "atomic", async (...args: unknown[]) => {const reply = await atomic.apply(instance, args); await reply.text(); return new Response("lost", {status: 503});});
      try {expect(await writeStatus(graph, id, [fact(first)])).toMatchObject({status: 503});}
      finally {Reflect.set(instance, "atomic", atomic);}
      expect(state.storage.sql.exec("SELECT owner_released FROM shard_transactions").one()).toMatchObject({owner_released: 0});
    });
    const oldView = await query(graph); expect(oldView.status).toBe(200);
    expect((await oldView.json() as {rows: unknown[]}).rows).toHaveLength(0);
    await evictDurableObject(env.GRAPH_LEDGERS.getByName(await transactionCoordinatorName(graph, id)));
    await evictDurableObject(leaf);
    expect(await writeStatus(graph, id, [fact(first)])).toMatchObject({status: 200});
    await runInDurableObject(leaf, (_instance, state) => expect(auditFactStorage(state.storage, 0).facts).toHaveLength(1));
  });

  it("allows disjoint reservation but serializes same-owner publication without exposing a fractured read", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, same, root} = await fixtures(graph), id = "integrated:held-low-ticket";
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), async (instance, state) => {
      const atomic = Reflect.get(instance, "atomic");
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => {enter = resolve;}), gate = new Promise<void>(resolve => {release = resolve;});
      Reflect.set(instance, "atomic", async (request: Request) => {
        const body = await request.clone().json() as {txId: string};
        if (body.txId === id) {enter(); await gate;} return atomic.call(instance, request);
      });
      const held = write(graph, id, [fact(first)]);
      const higher = writeStatus(graph, "integrated:higher-ticket", [fact(same)]);
      try {
        await entered;
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(await Promise.race([higher.then(() => "settled"), new Promise<string>(resolve => setTimeout(() => resolve("waiting"), 20))]))
          .toBe("waiting");
        expect(await writeStatus(graph, "integrated:overlap-field", [{...fact(first), field: "wiki:person:other"}])).toMatchObject({status: 423});
        expect(await writeStatus(graph, id, [fact(same)])).toMatchObject({status: 409});
        const oldView = await query(graph); expect(oldView.status).toBe(200);
        expect((await oldView.json() as {rows: unknown[]}).rows).toHaveLength(0);
        expect(await split(graph, root)).toMatchObject({status: 423});
        await runInDurableObject(env.GRAPH_TREES.getByName(treeCoordinatorName(graph, root)), (_owner, ownerState) => {
          expect(ownerState.storage.sql.exec("SELECT visible_seq FROM graph_state").one()).toMatchObject({visible_seq: 0});
          expect(ownerState.storage.sql.exec("SELECT ticket_seq, phase FROM tree_reservations WHERE tx_id = ?", id).one())
            .toMatchObject({ticket_seq: 1, phase: "preparing"});
        });
        expect(auditFactStorage(state.storage, 0).facts).toHaveLength(0);
      } finally {
        release(); Reflect.set(instance, "atomic", atomic);
        const [answer, higherAnswer] = await Promise.all([held, higher]);
        expect(answer.status).toBe(200); await answer.text();
        expect(higherAnswer.status).toBe(200);
      }
    });
    const read = await query(graph); expect(read.status).toBe(200); expect((await read.json() as {rows: unknown[]}).rows).toHaveLength(2);
  });

  it("finalizes disjoint roots concurrently while readers retain the prior closed vector", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, other, root, otherRoot} = await fixtures(graph);
    expect(root).not.toBe(otherRoot);
    const firstId = "integrated:disjoint-root-a";
    let secondId = "integrated:disjoint-root-b";
    for (let index = 0; await transactionCoordinatorName(graph, firstId) === await transactionCoordinatorName(graph, secondId); index++)
      secondId = `integrated:disjoint-root-b-${index}`;
    const roots = [root, otherRoot] as const;
    const leaves = roots.map(owner => env.GRAPH_SHARDS.getByName(shardObjectName(graph, owner)));
    const originals: unknown[] = [];
    await Promise.all(leaves.map((leaf, index) => runInDurableObject(leaf, instance => {
      const atomic = Reflect.get(instance, "atomic"); originals[index] = atomic;
      Reflect.set(instance, "atomic", async (request: Request) => {
        await new Promise(resolve => setTimeout(resolve, 500));
        return atomic.call(instance, request);
      });
    })));
    const writes = Promise.all([
      writeStatus(graph, firstId, [fact(first)]),
      writeStatus(graph, secondId, [fact(other)]),
    ]);
    try {
      let bothGated = false;
      for (let attempt = 0; attempt < 50 && !bothGated; attempt++) {
        const counts = await Promise.all(roots.map(owner => runInDurableObject(
          env.GRAPH_TREES.getByName(treeCoordinatorName(graph, owner)), (_instance, state) =>
            state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM tree_publication_gates").one().count)));
        bothGated = counts.every(count => count === 1);
        if (!bothGated) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(bothGated).toBe(true);
      const oldView = await query(graph); expect(oldView.status).toBe(200);
      expect((await oldView.json() as {rows: unknown[]}).rows).toHaveLength(0);
      const answers = await writes;
      expect(answers.map(answer => answer.status)).toEqual([200, 200]);
    } finally {
      await writes;
      await Promise.all(leaves.map((leaf, index) => runInDurableObject(leaf, instance => Reflect.set(instance, "atomic", originals[index]))));
    }
    await runInDurableObject(env.GRAPH_FACADES.getByName(storage.coordinatorObjectName(graph)), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT frontier FROM graph_safe_frontier").one()).toMatchObject({frontier: 2});
      const vector = state.storage.sql.exec<{prefix: string; visible_seq: number}>("SELECT prefix, visible_seq FROM graph_safe_vector").toArray();
      for (const owner of roots) expect(vector.find(entry => entry.prefix === owner)?.visible_seq).toBe(1);
    });
  });

  it("queues same-owner same-bucket publication while isolating a held execution and binding changed payloads", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, same, root} = await fixtures(graph), id = "integrated:pooled-held";
    const bucket = (await sha256Hex(id))[0]; let second = "";
    for (let i = 0; !second; i++) {const next = `integrated:pooled-${i}`; if ((await sha256Hex(next))[0] === bucket) second = next;}
    expect(await transactionCoordinatorName(graph, id)).toBe(await transactionCoordinatorName(graph, second));
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), async instance => {
      const atomic = Reflect.get(instance, "atomic"); let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => {enter = resolve;}), gate = new Promise<void>(resolve => {release = resolve;});
      Reflect.set(instance, "atomic", async (request: Request) => {
        if ((await request.clone().json() as {txId: string}).txId === id) {enter(); await gate;} return atomic.call(instance, request);
      });
      const held = write(graph, id, [fact(first)]);
      const queued = writeStatus(graph, second, [fact(same)]);
      try {
        await entered;
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(await Promise.race([queued.then(() => "settled"), new Promise<string>(resolve => setTimeout(() => resolve("waiting"), 20))]))
          .toBe("waiting");
        expect(await writeStatus(graph, id, [fact(first)])).toMatchObject({status: 423});
        expect(await writeStatus(graph, id, [fact(same)])).toMatchObject({status: 409});
      } finally {
        release(); Reflect.set(instance, "atomic", atomic);
        const [answer, queuedAnswer] = await Promise.all([held, queued]);
        expect(answer.status).toBe(200); await answer.text();
        expect(queuedAnswer.status).toBe(200);
      }
    });
  });

  it("rolls back a complete atomic application on exception and resumes its pinned authority", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, root} = await fixtures(graph), id = "integrated:rollback";
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), async (instance, state) => {
      const apply = Reflect.get(instance, "applyParticipantBatch");
      Reflect.set(instance, "applyParticipantBatch", (...args: unknown[]) => {apply.apply(instance, args); throw new Error("injected after full apply");});
      try {expect(await writeStatus(graph, id, [fact(first)])).toMatchObject({status: 503});}
      finally {Reflect.set(instance, "applyParticipantBatch", apply);}
      for (const table of ["fact_log", "entity_versions", "shard_transactions"]) expect(state.storage.sql.exec<{count: number}>(`SELECT COUNT(*) AS count FROM ${table}`).one().count).toBe(0);
    });
    expect(await writeStatus(graph, id, [fact(first)])).toMatchObject({status: 200});
  });

  it.each([false, true])("pins local terminal authority beyond its synthetic window until owner release (abort=%s)", async abort => {
    const graph = `test-${crypto.randomUUID()}`, {first, root} = await fixtures(graph), id = "integrated:old-pin";
    const leaf = env.GRAPH_SHARDS.getByName(shardObjectName(graph, root));
    await runInDurableObject(leaf, async instance => {
      const atomic = Reflect.get(instance, "atomic");
      Reflect.set(instance, "atomic", async (...args: unknown[]) => {const response = await atomic.apply(instance, args); await response.text(); return new Response("lost", {status: 503});});
      try {expect(await writeStatus(graph, id, [fact(first, abort)])).toMatchObject({status: 503});}
      finally {Reflect.set(instance, "atomic", atomic);}
    });
    await expireAnchor(graph, id, [root]); await runDurableObjectAlarm(leaf);
    await runInDurableObject(leaf, (_instance, state) => expect(state.storage.sql.exec("SELECT status, owner_released FROM shard_transactions").one())
      .toMatchObject({status: abort ? "cancelled" : "committed", owner_released: 0}));
    await recover(graph, id);
    await runInDurableObject(env.GRAPH_LEDGERS.getByName(await transactionCoordinatorName(graph, id)), (_instance, state) =>
      expect(state.storage.sql.exec("SELECT phase FROM candidate_transactions WHERE tx_id = ?", id).one()).toMatchObject({phase: abort ? "aborted" : "complete"}));
    await runInDurableObject(leaf, (_instance, state) => expect(auditFactStorage(state.storage, 0).facts).toHaveLength(abort ? 0 : 1));
  });

  it("logs a sanitized permanent distributed-prepare rejection before cancelling", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, other, root, otherRoot} = await fixtures(graph), id = "integrated:prepare-rejection-diagnostic";
    const second = env.GRAPH_SHARDS.getByName(shardObjectName(graph, otherRoot));
    const diagnostics: unknown[][] = [];
    const originalError = console.error;
    console.error = (...values: unknown[]) => { diagnostics.push(values); };
    try {
      await runInDurableObject(second, async instance => {
        const prepare = Reflect.get(instance, "prepare");
        Reflect.set(instance, "prepare", () => new Response(JSON.stringify({error: "transaction was cancelled for private:entity"}), {status: 409}));
        try { expect(await writeStatus(graph, id, [fact(first), fact(other)])).toMatchObject({status: 422}); }
        finally { Reflect.set(instance, "prepare", prepare); }
      });
    } finally { console.error = originalError; }
    const abort = diagnostics.map(([value]) => typeof value === "string" ? JSON.parse(value) as Record<string, unknown> : undefined)
      .find(value => value?.["event"] === "poneglyph.transaction.aborted");
    expect(abort).toMatchObject({event: "poneglyph.transaction.aborted", phase: "prepare", reasonCode: "participant-rejected"});
    expect(abort?.["failures"]).toEqual(expect.arrayContaining([expect.objectContaining({status: 409, reasonCode: "participant-cancelled"})]));
    expect(JSON.stringify(diagnostics)).not.toContain("private:entity");
    expect(JSON.stringify(diagnostics)).not.toContain(id);
    for (const prefix of [otherRoot, root]) {
      await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, prefix)), (_instance, state) =>
        expect(auditFactStorage(state.storage, 0).facts).toHaveLength(0));
    }
  });

  it("recovers partial distributed prepare after actual eviction with complete indices and no double growth", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, other, root, otherRoot} = await fixtures(graph), id = "integrated:partial-prepare";
    const second = env.GRAPH_SHARDS.getByName(shardObjectName(graph, otherRoot));
    await runInDurableObject(second, async instance => {
      const prepare = Reflect.get(instance, "prepare"); Reflect.set(instance, "prepare", () => new Response("unavailable", {status: 503}));
      try {expect(await writeStatus(graph, id, [fact(first), fact(other)])).toMatchObject({status: 503});}
      finally {Reflect.set(instance, "prepare", prepare);}
    });
    const firstLeaf = env.GRAPH_SHARDS.getByName(shardObjectName(graph, root));
    await runInDurableObject(firstLeaf, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT status FROM shard_transactions").one()).toMatchObject({status: "prepared"});
      expect(state.storage.sql.exec<{bytes: number}>("SELECT reserved_mutation_bytes AS bytes FROM shard_transactions").one().bytes).toBeGreaterThan(0);
      expect(auditFactStorage(state.storage, 0).facts).toHaveLength(0);
    });
    await evictDurableObject(env.GRAPH_LEDGERS.getByName(await transactionCoordinatorName(graph, id)));
    await evictDurableObject(firstLeaf); await evictDurableObject(second);
    expect(await writeStatus(graph, id, [fact(first), fact(other)])).toMatchObject({status: 200});
    for (const owner of [root, otherRoot]) await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, owner)), (_instance, state) => {
      expect(auditFactStorage(state.storage, 0).facts).toHaveLength(1);
      expect(state.storage.sql.exec("SELECT reserved_mutation_bytes, owner_released FROM shard_transactions").one()).toMatchObject({reserved_mutation_bytes: 0, owner_released: 1});
    });
  });

  it("retains a distributed applied outcome beyond expiry while another same-leaf writer publishes", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, same, other, root, otherRoot} = await fixtures(graph), id = "integrated:partial-apply";
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, otherRoot)), async instance => {
      const commit = Reflect.get(instance, "commit"); Reflect.set(instance, "commit", () => new Response("unavailable", {status: 503}));
      try {expect(await writeStatus(graph, id, [fact(first), fact(other)])).toMatchObject({status: 503});}
      finally {Reflect.set(instance, "commit", commit);}
    });
    await expireAnchor(graph, id, [root, otherRoot]);
    const leaf = env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)); await runDurableObjectAlarm(leaf);
    expect(await writeStatus(graph, "integrated:disjoint-after-apply", [fact(same)])).toMatchObject({status: 503});
    await runInDurableObject(leaf, (_instance, state) => expect(state.storage.sql.exec("SELECT status, owner_released FROM shard_transactions WHERE tx_id = ?", id).one())
      .toMatchObject({status: "committed", owner_released: 0}));
    const oldView = await query(graph); expect(oldView.status).toBe(200);
    expect((await oldView.json() as {rows: unknown[]}).rows).toHaveLength(0);
    await recover(graph, id);
    expect(await writeStatus(graph, "integrated:disjoint-after-apply", [fact(same)])).toMatchObject({status: 200});
    await runInDurableObject(leaf, (_instance, state) => expect(auditFactStorage(state.storage, 0).facts).toHaveLength(2));
    const read = await query(graph); expect(read.status).toBe(200); expect((await read.json() as {rows: unknown[]}).rows).toHaveLength(3);
  });

  it("rejects A/B1 marker reinterpretation synchronously without poisoning an input gate", async () => {
    const graph = `test-${crypto.randomUUID()}`;
    const {root} = await fixtures(graph);
    await runInDurableObject(env.GRAPH_TREES.getByName(treeCoordinatorName(graph, root)), (_instance, state) => {
      state.storage.sql.exec("UPDATE poneglyph_schema SET kind = 'candidate-tree', version = 2");
      try {expect(() => ensureTreeSchema(state.storage)).toThrow(/unsupported g-tree/);}
      finally {state.storage.sql.exec("UPDATE poneglyph_schema SET kind = 'g-tree', version = 1");}
    });
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), (_instance, state) => {
      state.storage.sql.exec("UPDATE poneglyph_schema SET kind = 'candidate-shard', version = 2");
      try {expect(() => ensureShardSchema(state.storage)).toThrow(/unsupported g-shard/);}
      finally {state.storage.sql.exec("UPDATE poneglyph_schema SET kind = 'g-shard', version = 7");}
    });
  });

  it.each([false, true])("recovers lost owner publication across completed migration without replaying physical mutations (distributed=%s)", async distributed => {
    const graph = `test-${crypto.randomUUID()}`, {first, other, root, otherRoot} = await fixtures(graph), id = "integrated:lost-publication";
    const roots = distributed ? [root, otherRoot].sort() : [root], published = roots[0]!;
    const facts = distributed ? [fact(first), fact(other)] : [fact(first)];
    await runInDurableObject(env.GRAPH_TREES.getByName(treeCoordinatorName(graph, published)), async instance => {
      const control = Reflect.get(instance, "treeControl");
      Reflect.set(instance, "treeControl", async (request: Request) => {
        const answer = await control.call(instance, request);
        if (new URL(request.url).pathname === "/_tree-finish") {await answer.text(); return new Response("lost publication", {status: 503});}
        return answer;
      });
      try {expect(await writeStatus(graph, id, facts)).toMatchObject({status: 503});}
      finally {Reflect.set(instance, "treeControl", control);}
    });
    await runInDurableObject(env.GRAPH_LEDGERS.getByName(await transactionCoordinatorName(graph, id)), (_instance, state) => {
      const row = state.storage.sql.exec("SELECT phase, participant_witness, local_witness_json FROM candidate_transactions WHERE tx_id = ?", id).one();
      expect(row).toMatchObject({phase: distributed ? "committing" : "atomic-delegated", participant_witness: distributed ? 1 : 0});
      if (!distributed) expect(row["local_witness_json"]).not.toBeNull();
    });
    expect(await split(graph, published)).toMatchObject({status: 423});
    await recover(graph, id);
    expect(await split(graph, published)).toMatchObject({status: 200});
    await evictDurableObject(env.GRAPH_LEDGERS.getByName(await transactionCoordinatorName(graph, id)));
    const leaf = env.GRAPH_SHARDS.getByName(shardObjectName(graph, published));
    await runInDurableObject(leaf, async (instance, state) => {
      const method = distributed ? "commit" : "atomic", original = Reflect.get(instance, method);
      Reflect.set(instance, method, () => {throw new Error("unexpected physical decision replay after owner publication");});
      try {expect(await writeStatus(graph, id, facts)).toMatchObject({status: 200});}
      finally {Reflect.set(instance, method, original);}
      expect(state.storage.sql.exec("SELECT role, migration_state FROM shard_identity").one()).toMatchObject({role: "router", migration_state: "retired"});
      expect(state.storage.sql.exec("SELECT owner_released FROM shard_transactions WHERE tx_id = ?", id).one()).toMatchObject({owner_released: 1});
      expect(auditFactStorage(state.storage, 0).facts).toHaveLength(0);
    });
    expect(await writeStatus(graph, id, facts)).toMatchObject({status: 200});
    const read = await query(graph); expect(read.status).toBe(200); expect((await read.json() as {rows: unknown[]}).rows).toHaveLength(distributed ? 2 : 1);
  });

  it("recovers cancellation release across migration using a durable all-cancelled witness", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, other, root, otherRoot} = await fixtures(graph), id = "integrated:lost-cancel-release";
    expect(await writeStatus(graph, "integrated:seed-before-cancel", [fact(first), fact(other)])).toMatchObject({status: 200});
    const released = [root, otherRoot].sort()[0]!;
    await runInDurableObject(env.GRAPH_TREES.getByName(treeCoordinatorName(graph, released)), async instance => {
      const control = Reflect.get(instance, "treeControl");
      Reflect.set(instance, "treeControl", async (request: Request) => {
        const answer = await control.call(instance, request);
        if (new URL(request.url).pathname === "/_tree-unlock") {await answer.text(); return new Response("lost release", {status: 503});}
        return answer;
      });
      try {expect(await writeStatus(graph, id, [fact(first, false, "new"), fact(other, true, "missing")])).toMatchObject({status: 503});}
      finally {Reflect.set(instance, "treeControl", control);}
    });
    await runInDurableObject(env.GRAPH_LEDGERS.getByName(await transactionCoordinatorName(graph, id)), (_instance, state) =>
      expect(state.storage.sql.exec("SELECT phase, participant_witness FROM candidate_transactions WHERE tx_id = ?", id).one()).toMatchObject({phase: "cancelling", participant_witness: 1}));
    expect(await split(graph, released)).toMatchObject({status: 200});
    await recover(graph, id);
    expect(await writeStatus(graph, id, [fact(first, false, "new"), fact(other, true, "missing")])).toMatchObject({status: 422});
    const read = await query(graph); expect(read.status).toBe(200); expect((await read.json() as {rows: unknown[]}).rows).toHaveLength(2);
  });

  it("does read-only planning outside reservations and rejects a stale split plan before any participant mutation", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, same, root} = await fixtures(graph), id = "integrated:provisional-split";
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), async instance => {
      const preflight = Reflect.get(instance, "preflight"); let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => {enter = resolve;}), gate = new Promise<void>(resolve => {release = resolve;});
      Reflect.set(instance, "preflight", async (request: Request) => {
        if ((await request.clone().json() as {txId: string}).txId === id) {enter(); await gate;} return preflight.call(instance, request);
      });
      const held = write(graph, id, [fact(first)]);
      try {
        await entered;
        await runInDurableObject(env.GRAPH_TREES.getByName(treeCoordinatorName(graph, root)), (_owner, state) => {
          expect(state.storage.sql.exec("SELECT * FROM entity_write_locks").toArray()).toHaveLength(0);
          expect(state.storage.sql.exec("SELECT * FROM tree_reservations").toArray()).toHaveLength(0);
        });
        expect(await writeStatus(graph, "integrated:during-planning", [fact(same)])).toMatchObject({status: 200});
        const read = await query(graph); expect(read.status).toBe(200); await read.text();
        expect(await split(graph, root)).toMatchObject({status: 200});
      } finally {release(); Reflect.set(instance, "preflight", preflight);}
      const stale = await held; expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({retryable: true});
    });
    await runInDurableObject(env.GRAPH_LEDGERS.getByName(await transactionCoordinatorName(graph, id)), (_instance, state) =>
      expect(state.storage.sql.exec("SELECT * FROM candidate_transactions WHERE tx_id = ?", id).toArray()).toHaveLength(0));
    expect(await writeStatus(graph, id, [fact(first)])).toMatchObject({status: 200});
    const read = await query(graph); expect((await read.json() as {rows: unknown[]}).rows).toHaveLength(2);
  });

  it("cancels stranded unadmitted reservations after interrupted release rather than delivering new input on alarm", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, other, root, otherRoot} = await fixtures(graph), id = "integrated:stranded-reserving";
    const [earlier, later] = [root, otherRoot].sort();
    await runInDurableObject(env.GRAPH_TREES.getByName(treeCoordinatorName(graph, earlier!)), async earlierInstance => {
      const earlierControl = Reflect.get(earlierInstance, "treeControl");
      Reflect.set(earlierInstance, "treeControl", async (request: Request) => {
        const answer = await earlierControl.call(earlierInstance, request);
        if (new URL(request.url).pathname === "/_tree-unlock") {await answer.text(); return new Response("lost release", {status: 503});}
        return answer;
      });
      try {
        await runInDurableObject(env.GRAPH_TREES.getByName(treeCoordinatorName(graph, later!)), async laterInstance => {
          const laterControl = Reflect.get(laterInstance, "treeControl");
          Reflect.set(laterInstance, "treeControl", (request: Request) => new URL(request.url).pathname === "/_tree-lock"
            ? new Response(JSON.stringify({error: "injected contention", retryable: true}), {status: 423}) : laterControl.call(laterInstance, request));
          try {expect(await writeStatus(graph, id, [fact(first), fact(other)])).toMatchObject({status: 503});}
          finally {Reflect.set(laterInstance, "treeControl", laterControl);}
        });
      } finally {Reflect.set(earlierInstance, "treeControl", earlierControl);}
    });
    await runInDurableObject(env.GRAPH_LEDGERS.getByName(await transactionCoordinatorName(graph, id)), (_instance, state) =>
      expect(state.storage.sql.exec("SELECT phase FROM candidate_transactions WHERE tx_id = ?", id).one()).toMatchObject({phase: "reserving"}));
    await recover(graph, id);
    expect(await writeStatus(graph, id, [fact(first), fact(other)])).toMatchObject({status: 422});
    for (const prefix of [root, otherRoot]) {
      await runInDurableObject(env.GRAPH_TREES.getByName(treeCoordinatorName(graph, prefix)), (_instance, state) =>
        expect(state.storage.sql.exec("SELECT * FROM entity_write_locks").toArray()).toHaveLength(0));
      await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, prefix)), (_instance, state) =>
        expect(auditFactStorage(state.storage, 0).facts).toHaveLength(0));
    }
  });

  it("preserves acknowledgement when finalization fails and proves exact ticket release without touching facts", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, root} = await fixtures(graph), id = "integrated:finalization-failure";
    const leaf = env.GRAPH_SHARDS.getByName(shardObjectName(graph, root));
    await runInDurableObject(leaf, async instance => {
      const finalize = Reflect.get(instance, "finalizeDecision"); Reflect.set(instance, "finalizeDecision", () => new Response("deferred", {status: 503}));
      try {expect(await writeStatus(graph, id, [fact(first)])).toMatchObject({status: 200});}
      finally {Reflect.set(instance, "finalizeDecision", finalize);}
    });
    await runInDurableObject(leaf, (_instance, state) => expect(state.storage.sql.exec("SELECT owner_released FROM shard_transactions").one()).toMatchObject({owner_released: 0}));
    await runDurableObjectAlarm(leaf);
    await runInDurableObject(leaf, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT owner_released FROM shard_transactions").one()).toMatchObject({owner_released: 1});
      expect(auditFactStorage(state.storage, 0).facts).toHaveLength(1);
    });
  });

  it("pins MVCC history across writes, fences topology, and rejects an expired physical read", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, root} = await fixtures(graph);
    expect(await writeStatus(graph, "integrated:lease-seed", [fact(first)])).toMatchObject({status: 200});
    const owner = env.GRAPH_TREES.getByName(treeCoordinatorName(graph, root));
    const response = await owner.fetch("https://owner.internal/_tree-read", {method: "POST", body: JSON.stringify({
      graphId: graph, prefix: root, snapshotSeq: 1, directoryEpoch: 0,
    })});
    expect(response.status).toBe(200); const lease = await response.json() as {readId: string; snapshotSeq: number; directoryEpoch: number};
    expect(await writeStatus(graph, "integrated:lease-write", [fact(first, false, "later")])).toMatchObject({status: 200});
    expect(await split(graph, root)).toMatchObject({status: 423});
    const historical = await env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)).fetch("https://leaf.internal/_entity", {
      method: "POST", body: JSON.stringify({graphId: graph, entity: first, shardPrefix: root, shardGeneration: 0,
        directoryEpoch: lease.directoryEpoch, snapshotSeq: lease.snapshotSeq, leaseExpiresAtMs: Date.now() + 10_000}),
    });
    expect(historical.status).toBe(200);
    expect(await historical.json()).toMatchObject({lastProcessedTxId: "integrated:lease-seed", snapshotSeq: lease.snapshotSeq});
    await runInDurableObject(owner, (_instance, state) => state.storage.sql.exec("UPDATE graph_read_leases SET expires_at_ms = 0 WHERE read_id = ?", lease.readId));
    const expired = await env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)).fetch("https://leaf.internal/_entity", {
      method: "POST", body: JSON.stringify({graphId: graph, entity: first, shardPrefix: root, shardGeneration: 0,
        directoryEpoch: lease.directoryEpoch, snapshotSeq: lease.snapshotSeq, leaseExpiresAtMs: 0}),
    });
    expect(expired.status).toBe(410); await expired.text();
  });

  it("admits more than 128 exact read leases on one owner without a fixed application cap", async () => {
    const graph = `test-${crypto.randomUUID()}`, prefix = TREE_PREFIXES[0]!;
    const owner = env.GRAPH_TREES.getByName(treeCoordinatorName(graph, prefix));
    const leases: {readId: string}[] = [];
    try {
      for (let index = 0; index < 256; index++) {
        const response = await owner.fetch("https://owner.internal/_tree-read", {method: "POST", body: JSON.stringify({
          graphId: graph, prefix, snapshotSeq: 0, directoryEpoch: 0,
        })});
        expect(response.status).toBe(200);
        leases.push(await response.json() as {readId: string});
      }
      await runInDurableObject(owner, (_instance, state) => {
        expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM graph_read_leases").one()["count"]).toBe(256);
      });
    } finally {
      await Promise.all(leases.map(lease => owner.fetch("https://owner.internal/_tree-release-read", {
        method: "POST", body: JSON.stringify({graphId: graph, prefix, readId: lease.readId}),
      })));
    }
  });

  it("publishes different owner tickets as a vector rather than a graph-global scalar order", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, other, root, otherRoot} = await fixtures(graph);
    for (let i = 0; i < 5; i++) expect(await writeStatus(graph, `integrated:ticket-seed-${i}`, [fact(other, false, `seed-${i}`)])).toMatchObject({status: 200});
    const response = await write(graph, "integrated:vector-tickets", [fact(first), fact(other)]);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({commitSeq: 6, sequenceScope: "subtree-vector"});
    const read = await query(graph); expect(read.status).toBe(200);
    const body = await read.json() as {sequenceScope: string; snapshotVector: {prefix: string; sequence: number}[]};
    expect(body.sequenceScope).toBe("subtree-vector");
    expect(body.snapshotVector.find(value => value.prefix === root)?.sequence).toBe(1);
    expect(body.snapshotVector.find(value => value.prefix === otherRoot)?.sequence).toBe(6);
  });

  it("does not replace actual atomic admission with an earlier positive provisional preflight", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, root} = await fixtures(graph), id = "integrated:capacity-changed";
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), async (instance, state) => {
      const preflight = Reflect.get(instance, "preflight");
      Reflect.set(instance, "preflight", async (request: Request) => {
        const body = await request.clone().json() as {txId: string};
        const answer = await preflight.call(instance, request);
        if (body.txId === id) state.storage.sql.exec("UPDATE shard_accounting SET synthetic_size_bytes = ?", MAX_ACCOUNTED_BYTES_PER_DO);
        return answer;
      });
      try {expect(await writeStatus(graph, id, [fact(first)])).toMatchObject({status: 422});}
      finally {Reflect.set(instance, "preflight", preflight); state.storage.sql.exec("UPDATE shard_accounting SET synthetic_size_bytes = 0");}
      expect(state.storage.sql.exec("SELECT status, atomic_rejection_status FROM shard_transactions").one()).toMatchObject({status: "cancelled", atomic_rejection_status: 413});
      expect(auditFactStorage(state.storage, 0).facts).toHaveLength(0);
    });
  });

  it("rechecks provisional rejection after a disjoint visibility change instead of treating it as admission truth", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, same, root} = await fixtures(graph), id = "integrated:negative-preflight";
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), async instance => {
      const preflight = Reflect.get(instance, "preflight"); let checks = 0;
      Reflect.set(instance, "preflight", async (request: Request) => {
        const body = await request.clone().json() as {txId: string};
        if (body.txId === id && ++checks === 1) {
          expect(await writeStatus(graph, "integrated:negative-disjoint", [fact(same)])).toMatchObject({status: 200});
          return new Response(JSON.stringify({canAdmit: false, shouldSplit: false}));
        }
        return preflight.call(instance, request);
      });
      try {expect(await writeStatus(graph, id, [fact(first)])).toMatchObject({status: 200}); expect(checks).toBe(2);}
      finally {Reflect.set(instance, "preflight", preflight);}
    });
  });

  it("accounts prepared future growth before another disjoint atomic or distributed admission under synthetic pressure", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, same, root} = await fixtures(graph), leaf = env.GRAPH_SHARDS.getByName(shardObjectName(graph, root));
    const participant = async (id: string, entity: string, seq: number) => {
      const value = fact(entity, false, "x".repeat(400_000)), batch = parseFactBatch({txId: id, facts: [value]});
      if (!batch.ok) throw new Error(batch.error.message);
      return {graphId: graph, shardPrefix: root, shardGeneration: 0, directoryEpoch: 0, txId: id,
        payloadHash: await sha256Hex(canonicalBatchJson(batch.value)), commitSeq: seq, statementTimeMs: Date.now(), identityTimeMs: Date.now(),
        facts: [{index: 0, virtualKey: await virtualKeyForEntity(graph, entity), fact: value}]};
    };
    const prepared = await participant("integrated:capacity-prepared", first, 1), atomic = await participant("integrated:capacity-atomic", same, 2);
    const staged = await leaf.fetch("https://leaf.internal/_prepare", {method: "POST", body: JSON.stringify(prepared)});
    expect(staged.status).toBe(200); await staged.text();
    await runInDurableObject(leaf, (instance, state) => {
      const growth = state.storage.sql.exec<{bytes: number}>("SELECT reserved_mutation_bytes AS bytes FROM shard_transactions WHERE tx_id = ?", prepared.txId).one().bytes;
      expect(growth).toBeGreaterThan(0);
      const capacity = Reflect.get(instance, "capacityFor");
      state.storage.sql.exec("UPDATE shard_transactions SET reserved_mutation_bytes = 0 WHERE tx_id = ?", prepared.txId);
      let low = 0, high = MAX_ACCOUNTED_BYTES_PER_DO;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2); state.storage.sql.exec("UPDATE shard_accounting SET synthetic_size_bytes = ?", mid);
        if (capacity.call(instance, [atomic.facts[0]!.fact]).canAdmit) low = mid; else high = mid - 1;
      }
      state.storage.sql.exec("UPDATE shard_accounting SET synthetic_size_bytes = ?", low - Math.floor(growth / 2));
      expect(capacity.call(instance, [atomic.facts[0]!.fact]).canAdmit).toBe(true);
      state.storage.sql.exec("UPDATE shard_transactions SET reserved_mutation_bytes = ? WHERE tx_id = ?", growth, prepared.txId);
      expect(capacity.call(instance, [atomic.facts[0]!.fact]).canAdmit).toBe(false);
    });
    try {
      const replay = await leaf.fetch("https://leaf.internal/_prepare", {method: "POST", body: JSON.stringify(prepared)}); expect(replay.status).toBe(200); await replay.text();
      const outcome = await leaf.fetch("https://leaf.internal/_atomic", {method: "POST", body: JSON.stringify(atomic)});
      expect(outcome.status).toBe(200); expect(await outcome.json()).toMatchObject({status: "aborted", rejectionStatus: 413});
      const third = await participant("integrated:capacity-other-prepare", same, 3);
      const rejected = await leaf.fetch("https://leaf.internal/_prepare", {method: "POST", body: JSON.stringify(third)}); expect(rejected.status).toBe(413); await rejected.text();
      const cancelled = await leaf.fetch("https://leaf.internal/_cancel", {method: "POST", body: JSON.stringify({...prepared, facts: undefined})}); expect(cancelled.status).toBe(200); await cancelled.text();
    } finally {await runInDurableObject(leaf, (_instance, state) => state.storage.sql.exec("UPDATE shard_accounting SET synthetic_size_bytes = 0"));}
    await runInDurableObject(leaf, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT reserved_mutation_bytes FROM shard_transactions WHERE tx_id = ?", prepared.txId).one()).toMatchObject({reserved_mutation_bytes: 0});
      expect(auditFactStorage(state.storage, 0).facts).toHaveLength(0);
    });
  });

  it("fails closed on a missing durable journal despite a matching retry body, then cold-recovers the exact restored fixture", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, root} = await fixtures(graph), id = "integrated:missing-journal";
    const leaf = env.GRAPH_SHARDS.getByName(shardObjectName(graph, root));
    await runInDurableObject(leaf, async instance => {
      const atomic = Reflect.get(instance, "atomic");
      Reflect.set(instance, "atomic", async (...args: unknown[]) => {const response = await atomic.apply(instance, args); await response.text(); return new Response("lost", {status: 503});});
      try {expect(await writeStatus(graph, id, [fact(first)])).toMatchObject({status: 503});}
      finally {Reflect.set(instance, "atomic", atomic);}
    });
    const ledger = env.GRAPH_LEDGERS.getByName(await transactionCoordinatorName(graph, id));
    const original = await runInDurableObject(ledger, (_instance, state) => {
      const json = state.storage.sql.exec<{batch_json: string}>("SELECT batch_json FROM candidate_transactions WHERE tx_id = ?", id).one().batch_json;
      state.storage.sql.exec("UPDATE candidate_transactions SET batch_json = 'null' WHERE tx_id = ?", id); return json;
    });
    await evictDurableObject(ledger);
    try {
      expect(await writeStatus(graph, id, [fact(first)])).toMatchObject({status: 503});
      const oldView = await query(graph); expect(oldView.status).toBe(200);
      expect((await oldView.json() as {rows: unknown[]}).rows).toHaveLength(0);
      await runInDurableObject(leaf, (_instance, state) => expect(auditFactStorage(state.storage, 0).facts).toHaveLength(1));
    } finally {await runInDurableObject(ledger, (_instance, state) => state.storage.sql.exec("UPDATE candidate_transactions SET batch_json = ? WHERE tx_id = ?", original, id));}
    expect(await writeStatus(graph, id, [fact(first)])).toMatchObject({status: 200});
  });

  it("uses only an exact durable prepared-payload hot slot and clears it after commit", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, other, root} = await fixtures(graph); let hits = 0;
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), async instance => {
      const decode = Reflect.get(instance, "decodePrepared");
      Reflect.set(instance, "decodePrepared", (json: string) => {
        const slot = Reflect.get(instance, "staged"), batch = decode.call(instance, json);
        expect(slot.payloadJson).toBe(json); expect(batch).toBe(slot.batch); hits++; return batch;
      });
      try {expect(await writeStatus(graph, "integrated:hot-slot", [fact(first), fact(other)])).toMatchObject({status: 200});}
      finally {Reflect.set(instance, "decodePrepared", decode);}
      expect(Reflect.get(instance, "staged")).toBeUndefined();
    });
    expect(hits).toBe(1);
  });

  it("bounds actor batch cache by entries/serialized bytes and requires exact journal equality", () => {
    const cache = new BatchCache(), entries = Array.from({length: 9}, (_, i) => {
      const batch = parseFactBatch({txId: `integrated:cache-${i}`, facts: [fact("wiki:person:cache")]});
      if (!batch.ok) throw new Error(batch.error.message); return {batch: batch.value, json: canonicalBatchJson(batch.value)};
    });
    for (const entry of entries) cache.put(entry.batch.txId, entry.json, entry.batch);
    expect(cache.get(entries[0]!.batch.txId, entries[0]!.json)).toBeUndefined();
    expect(cache.get(entries[8]!.batch.txId, entries[8]!.json)).toBe(entries[8]!.batch);
    expect(cache.get(entries[8]!.batch.txId, entries[8]!.json + " ")).toBeUndefined();
    cache.delete(entries[8]!.batch.txId); expect(cache.get(entries[8]!.batch.txId, entries[8]!.json)).toBeUndefined();
    const large = Array.from({length: 5}, (_, i) => {
      const batch = parseFactBatch({txId: `integrated:large-cache-${i}`, facts: [fact("wiki:person:cache", false, "x".repeat(950_000))]});
      if (!batch.ok) throw new Error(batch.error.message); return {batch: batch.value, json: canonicalBatchJson(batch.value)};
    });
    for (const entry of large) cache.put(entry.batch.txId, entry.json, entry.batch);
    expect(cache.get(large[0]!.batch.txId, large[0]!.json)).toBeUndefined();
    expect(cache.get(large[4]!.batch.txId, large[4]!.json)).toBe(large[4]!.batch);
  });

  it("binds owner entity sets and stays fail-closed if a pending reservation loses its durable lock", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, same, root} = await fixtures(graph), id = "integrated:owner-invariant", hash = "1".repeat(64), anchor = Date.now();
    const owner = env.GRAPH_TREES.getByName(treeCoordinatorName(graph, root));
    const control = async (action: string, extra: object = {}) => {
      const response = await owner.fetch(`https://owner.internal/${action}`, {method: "POST", body: JSON.stringify({graphId: graph, prefix: root,
        txId: id, payloadHash: hash, identityTimeMs: anchor, directoryEpoch: 0, ...extra})});
      return {status: response.status, body: await response.text()};
    };
    expect(await control("_tree-lock", {entities: [first]})).toMatchObject({status: 200});
    expect(await control("_tree-lock", {entities: [first, same].sort()})).toMatchObject({status: 409});
    await runInDurableObject(owner, (_instance, state) => state.storage.sql.exec("DELETE FROM entity_write_locks WHERE tx_id = ?", id));
    try {
      const read = await query(graph); expect(read.status).toBe(200);
      expect((await read.json() as {rows: unknown[]}).rows).toHaveLength(0);
      expect(await split(graph, root)).toMatchObject({status: 423});
      const proof = await control("_tree-atomic-proof", {commitSeq: 1, decision: "committed"});
      expect(proof.status).toBe(200); expect(JSON.parse(proof.body)).toMatchObject({authorityReleased: false});
      expect(await control("_tree-lock", {entities: [first]})).toMatchObject({status: 409});
    } finally {
      // Test cleanup only; there is no product repair on any query/recovery path.
      await runInDurableObject(owner, (_instance, state) => state.storage.sql.exec("INSERT INTO entity_write_locks VALUES (?, ?, ?)", first, id, hash));
      expect(await control("_tree-unlock")).toMatchObject({status: 200});
    }
  });

  it("bounds pooled recovery to 100 records/six drives and aborts unadmitted planning rather than feeding facts", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, root} = await fixtures(graph), seed = "integrated:recovery-bound";
    expect(await writeStatus(graph, seed, [fact(first)])).toMatchObject({status: 200});
    const bucket = (await sha256Hex(seed))[0], ids: string[] = [];
    for (let i = 0; ids.length < 105; i++) {const id = `integrated:bounded-${i}`; if ((await sha256Hex(id))[0] === bucket) ids.push(id);}
    const rows = await Promise.all(ids.map(async id => {
      const parsed = parseFactBatch({txId: id, facts: [fact(first)]}); if (!parsed.ok) throw new Error(parsed.error.message);
      const json = canonicalBatchJson(parsed.value); return {id, json, hash: await sha256Hex(json)};
    }));
    const ledger = env.GRAPH_LEDGERS.getByName(await transactionCoordinatorName(graph, seed));
    await runInDurableObject(ledger, async (instance: storage.GraphLedgerDO, state) => {
      // Metadata-only admission fixtures, not delivered writes or load evidence.
      for (const row of rows) state.storage.sql.exec(`INSERT INTO candidate_transactions
        (tx_id, graph_id, payload_hash, batch_json, trees_json, phase, commit_seq, statement_time_ms, created_at_ms, next_recovery_at_ms)
        VALUES (?, ?, ?, ?, '[]', 'planning', 0, 0, ?, 0)`, row.id, graph, row.hash, row.json, Date.now());
      const pool = Reflect.get(instance, "ledger"), execute = Reflect.get(pool, "execute");
      const runAlarm = Reflect.get(instance, "alarm") as () => Promise<void>;
      let calls = 0, live = 0, peak = 0;
      Reflect.set(pool, "execute", async (...args: unknown[]) => {
        calls++; live++; peak = Math.max(peak, live);
        try {return await execute.apply(pool, args);} finally {live--;}
      });
      try {await runAlarm.call(instance); expect(calls).toBe(100); expect(peak).toBeLessThanOrEqual(6);}
      finally {Reflect.set(pool, "execute", execute);}
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM candidate_transactions WHERE phase = 'planning'").one().count).toBe(5);
      await runAlarm.call(instance);
      // Remaining deadlines are due now but may have moved once; force the fixture.
      state.storage.sql.exec("UPDATE candidate_transactions SET next_recovery_at_ms = 0 WHERE phase = 'planning'");
      await runAlarm.call(instance);
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM candidate_transactions WHERE phase = 'aborted'").one().count).toBe(105);
      state.storage.sql.exec("UPDATE candidate_transactions SET created_at_ms = 0 WHERE phase = 'aborted'");
      await runAlarm.call(instance);
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM candidate_transactions WHERE phase = 'aborted'").one().count).toBe(5);
      await runAlarm.call(instance);
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM candidate_transactions WHERE phase = 'aborted'").one().count).toBe(0);
    });
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), (_instance, state) =>
      expect(auditFactStorage(state.storage, 0).facts).toHaveLength(1));
  });

  it("bounds participant publication proofs and terminal sweeps to 100 records with six workers and never deletes facts", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, root} = await fixtures(graph), leaf = env.GRAPH_SHARDS.getByName(shardObjectName(graph, root));
    await runInDurableObject(leaf, async instance => {
      const finalize = Reflect.get(instance, "finalizeDecision");
      Reflect.set(instance, "finalizeDecision", () => new Response("deferred", {status: 503}));
      try {for (let i = 0; i < 105; i++) expect(await writeStatus(graph, `integrated:proof-${i}`, [fact(first, true)])).toMatchObject({status: 422});}
      finally {Reflect.set(instance, "finalizeDecision", finalize);}
    });
    await runInDurableObject(leaf, async (instance: storage.GraphShardDO, state) => {
      const prove = Reflect.get(instance, "proveOwnerRelease");
      const runAlarm = Reflect.get(instance, "alarm") as () => Promise<void>;
      let calls = 0, live = 0, peak = 0;
      Reflect.set(instance, "proveOwnerRelease", async (...args: unknown[]) => {
        calls++; live++; peak = Math.max(peak, live);
        try {return await prove.apply(instance, args);} finally {live--;}
      });
      try {await runAlarm.call(instance); expect(calls).toBe(100); expect(peak).toBeLessThanOrEqual(6);}
      finally {Reflect.set(instance, "proveOwnerRelease", prove);}
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM shard_transactions WHERE owner_released = 0").one().count).toBe(5);
      await runAlarm.call(instance);
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM shard_transactions WHERE owner_released = 0").one().count).toBe(0);
      // Expired terminal metadata exercises only the synthetic sweep page bound.
      state.storage.sql.exec("UPDATE shard_transactions SET created_at_ms = 0");
      await runAlarm.call(instance);
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM shard_transactions").one().count).toBe(5);
      await runAlarm.call(instance);
      expect(state.storage.sql.exec<{count: number}>("SELECT COUNT(*) AS count FROM shard_transactions").one().count).toBe(0);
      expect(auditFactStorage(state.storage, 0).facts).toHaveLength(0);
    });
    // Sweeping terminal outcomes cannot remove a subsequently acknowledged fact.
    expect(await writeStatus(graph, "integrated:after-sweep", [fact(first)])).toMatchObject({status: 200});
    await runInDurableObject(leaf, (_instance, state) => state.storage.sql.exec("UPDATE shard_transactions SET created_at_ms = 0 WHERE tx_id = 'integrated:after-sweep'"));
    await runDurableObjectAlarm(leaf);
    await runInDurableObject(leaf, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT * FROM shard_transactions").toArray()).toHaveLength(0);
      expect(auditFactStorage(state.storage, 0).facts).toHaveLength(1);
    });
  });

  it("resumes an interrupted split after actual owner eviction while another owner progresses", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, same, other, root} = await fixtures(graph), id = "integrated:split-seed";
    expect(await writeStatus(graph, id, [fact(first), fact(same)])).toMatchObject({status: 200});
    expect(await split(graph, root, 1)).toMatchObject({status: 503});
    expect(await writeStatus(graph, "integrated:other-during-split", [fact(other)])).toMatchObject({status: 200});
    const busy = await query(graph); expect(busy.status).toBe(423); await busy.text();
    await evictDurableObject(env.GRAPH_TREES.getByName(treeCoordinatorName(graph, root)));
    expect(await split(graph, root)).toMatchObject({status: 200});
    expect(await writeStatus(graph, id, [fact(first), fact(same)])).toMatchObject({status: 200});
    const read = await query(graph); expect(read.status).toBe(200); expect((await read.json() as {rows: unknown[]}).rows).toHaveLength(3);
  });

  it("retains distributed authority for one-owner batches spanning multiple physical leaves", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, same, root} = await fixtures(graph), id = "integrated:one-owner-multileaf";
    expect(await writeStatus(graph, "integrated:multileaf-seed", [fact(first), fact(same)])).toMatchObject({status: 200});
    expect(await split(graph, root)).toMatchObject({status: 200});
    expect(await writeStatus(graph, id, [fact(first, false, "later"), fact(same, false, "later")])).toMatchObject({status: 200});
    await runInDurableObject(env.GRAPH_LEDGERS.getByName(await transactionCoordinatorName(graph, id)), (_instance, state) => {
      const row = state.storage.sql.exec<{plan_json: string; participant_witness: number; local_witness_json: string | null}>(
        "SELECT plan_json, participant_witness, local_witness_json FROM candidate_transactions WHERE tx_id = ?", id).one();
      const plan = JSON.parse(row.plan_json) as {owners: unknown[]; participants: unknown[]};
      expect(plan.owners).toHaveLength(1); expect(plan.participants).toHaveLength(2);
      expect(row.participant_witness).toBe(1); expect(row.local_witness_json).toBeNull();
    });
    const read = await query(graph); expect(read.status).toBe(200); expect((await read.json() as {rows: unknown[]}).rows).toHaveLength(4);
  });

  it("replays a lost final graph receipt after eviction without allowing identity to escape to another owner", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, other, root} = await fixtures(graph), id = "integrated:lost-graph-receipt";
    const lost = await write(graph, id, [fact(first)]); expect(lost.status).toBe(200); await lost.text();
    await evictDurableObject(env.GRAPH_LEDGERS.getByName(await transactionCoordinatorName(graph, id)));
    expect(await writeStatus(graph, id, [fact(first)])).toMatchObject({status: 200});
    expect(await writeStatus(graph, id, [fact(other)])).toMatchObject({status: 409});
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), (_instance, state) =>
      expect(auditFactStorage(state.storage, 0).facts).toHaveLength(1));
  });

  it("does not invent a local abort or alternate authority when a delegated generation is stale", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, root} = await fixtures(graph), id = "integrated:stale-delegation";
    await runInDurableObject(env.GRAPH_SHARDS.getByName(shardObjectName(graph, root)), async (instance, state) => {
      const atomic = Reflect.get(instance, "atomic");
      Reflect.set(instance, "atomic", async (request: Request) => {state.storage.sql.exec("UPDATE shard_identity SET generation = 1"); return atomic.call(instance, request);});
      try {
        expect(await writeStatus(graph, id, [fact(first)])).toMatchObject({status: 503});
        expect(state.storage.sql.exec("SELECT * FROM shard_transactions").toArray()).toHaveLength(0);
        expect(auditFactStorage(state.storage, 0).facts).toHaveLength(0);
        await runInDurableObject(env.GRAPH_LEDGERS.getByName(await transactionCoordinatorName(graph, id)), (_coordinator, ledger) =>
          expect(ledger.storage.sql.exec("SELECT phase FROM candidate_transactions WHERE tx_id = ?", id).one()).toMatchObject({phase: "atomic-delegated"}));
      } finally {Reflect.set(instance, "atomic", atomic); state.storage.sql.exec("UPDATE shard_identity SET generation = 0");}
    });
    expect(await writeStatus(graph, id, [fact(first)])).toMatchObject({status: 200});
  });

  it("proves an expired predecessor's release despite new same-ID locks, without deadlocking identity reuse", async () => {
    const graph = `test-${crypto.randomUUID()}`, {first, root} = await fixtures(graph), id = "integrated:reuse-pin";
    const leaf = env.GRAPH_SHARDS.getByName(shardObjectName(graph, root));
    await runInDurableObject(leaf, async instance => {
      const finalize = Reflect.get(instance, "finalizeDecision"); Reflect.set(instance, "finalizeDecision", () => new Response("lost notice", {status: 503}));
      try {expect(await writeStatus(graph, id, [fact(first)])).toMatchObject({status: 200});}
      finally {Reflect.set(instance, "finalizeDecision", finalize);}
    });
    await expireAnchor(graph, id, [root]);
    // The authoritative window expired. This is a new identity incarnation,
    // not an idempotent replay within the window; its ticket cannot be reused.
    expect(await writeStatus(graph, id, [fact(first)])).toMatchObject({status: 503});
    await runInDurableObject(env.GRAPH_TREES.getByName(treeCoordinatorName(graph, root)), (_instance, state) =>
      expect(state.storage.sql.exec("SELECT phase, ticket_seq FROM tree_reservations WHERE tx_id = ?", id).one()).toMatchObject({phase: "preparing", ticket_seq: 2}));
    await runDurableObjectAlarm(leaf);
    expect(await writeStatus(graph, id, [fact(first)])).toMatchObject({status: 200});
    await runInDurableObject(leaf, (_instance, state) => expect(auditFactStorage(state.storage, 0).facts).toHaveLength(2));
  });
});
