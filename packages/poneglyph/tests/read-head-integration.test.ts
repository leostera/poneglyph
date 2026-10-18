import {evictDurableObject, runDurableObjectAlarm, runInDurableObject} from "cloudflare:test";
import {env, exports} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import {parseGraphId} from "../src/domain/graph-id.js";
import {isRecord} from "../src/domain/result.js";
import {treeForKey, transactionCoordinatorName, tokenLedgerName} from "../src/storage/forest.js";
import {jsonResponse, readJsonBody, sha256Hex} from "../src/storage/http.js";
import {bitAt, coordinatorObjectName, shardObjectName, virtualKeyForEntity} from "../src/storage/keys.js";
import {READ_HEAD_PARENT_KEY} from "../src/storage/read-head-journal.js";
import {parseReadHeadParent} from "../src/storage/read-head-parent.js";
import {readHeadReplicaName} from "../src/storage/read-head-placement.js";

type Fact = {source: string; entity: string; field: string; value: {type: "boolean"; value: boolean} | {type: "text"; value: string}; retraction?: boolean};
function object(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) throw new Error("invalid fixture response");
  return raw;
}
async function decoded(response: Response) { return {status: response.status, body: object(await response.json())}; }
async function fixture(companion = false) {
  const graph = parseGraphId(`test-head-int-${crypto.randomUUID()}`);
  if (!graph.ok) throw new Error("invalid fixture graph");
  const graphId = graph.value, root = env.GRAPH_FACADES.getByName(coordinatorObjectName(graphId));
  const feature = "test:feature", featureKey = await virtualKeyForEntity(graphId, feature), featureRoot = treeForKey(featureKey);
  let credential = "test:credential", credentialRoot = treeForKey(await virtualKeyForEntity(graphId, credential));
  for (let n = 0; credentialRoot === featureRoot && n < 128; n++) {
    credential = `test:credential:${n}`; credentialRoot = treeForKey(await virtualKeyForEntity(graphId, credential));
  }
  if (credentialRoot === featureRoot) throw new Error("fixture could not separate owners");
  const featureFact = (enabled: boolean, retraction = false): Fact => ({source: "agent:head-test", entity: feature,
    field: "test:enabled", value: {type: "boolean", value: enabled}, retraction});
  const tokenFact = (value: string, retraction = false): Fact => ({source: "agent:head-test", entity: credential,
    field: "test:token", value: {type: "text", value}, retraction});
  const point = `test:enabled("${feature}", Enabled), test:token("${credential}", Token)`;
  const expected = (changed: boolean) => [{Enabled: {type: "string", value: String(changed)},
    Token: {type: "string", value: changed ? "fake-head-token-v1" : "fake-head-token-v0"}}];
  const commit = async (token: string, facts: readonly Fact[]) => decoded(await exports.default.fetch(
    new Request(`https://graph.test/v1/graphs/${graphId}/transactions`, {method: "POST", body: JSON.stringify({clientRequestToken: token, facts})})));
  const query = async (cold = false) => {
    const result = await decoded(await exports.default.fetch(new Request(`https://graph.test/v1/graphs/${graphId}/query`, {
      method: "POST", body: JSON.stringify({query: cold ? `${point}, test:enabled("${feature}", Enabled)` : point}),
    })));
    expect(result.status).toBe(200);
    return result.body;
  };
  const control = async (path: string, body: Record<string, unknown> = {}) => decoded(await root.fetch(`https://root.internal/_read-head-${path}`,
    {method: "POST", body: JSON.stringify({graphId, ...body})}));
  const parent = () => runInDurableObject(root, (_instance, ctx) => parseReadHeadParent(ctx.storage.kv.get(READ_HEAD_PARENT_KEY)));
  const head = (member: number) => env.GRAPH_FACADES.getByName(readHeadReplicaName(graphId, member));
  const hint = (result: Record<string, unknown>) => {
    if (!Array.isArray(result["snapshotVector"])) throw new Error("missing fixture vector");
    return result["snapshotVector"].map(object).filter(owner => owner["prefix"] === featureRoot || owner["prefix"] === credentialRoot)
      .map(owner => ({prefix: owner["prefix"], snapshotSeq: owner["sequence"], directoryEpoch: owner["epoch"]}));
  };
  const validate = async (member: number, result: Record<string, unknown>) => decoded(await head(member).fetch(
    "https://head.internal/_read-head-validate", {method: "POST", body: JSON.stringify({graphId, member, query: point, knownSnapshot: hint(result)})}));
  const facts: Fact[] = [featureFact(false), tokenFact("fake-head-token-v0")];
  if (companion) {
    let found = false;
    for (let n = 0; n < 1024 && !found; n++) {
      const entity = `test:companion:${n}`, key = await virtualKeyForEntity(graphId, entity);
      if (treeForKey(key) === featureRoot && bitAt(key, featureRoot.length) !== bitAt(featureKey, featureRoot.length)) {
        facts.push({...featureFact(false), entity}); found = true;
      }
    }
    if (!found) throw new Error("fixture could not find a split companion");
  }
  expect((await commit("head-seed", facts)).status).toBe(200);
  const initial = await query(); expect(initial["rows"]).toEqual(expected(false));
  const join = async () => {
    const status = await control("status");
    const result = await control("join", {expectedGeneration: status.body["generation"]});
    expect(result.status).toBe(200); expect(typeof result.body["member"]).toBe("number");
    if (typeof result.body["member"] !== "number") throw new Error("invalid fixture member");
    return result.body["member"];
  };
  const flip = () => commit("head-flip", [featureFact(false, true), featureFact(true),
    tokenFact("fake-head-token-v0", true), tokenFact("fake-head-token-v1")]);
  return {graphId, root, head, featureRoot, credentialRoot, control, parent, join, flip, query, initial, expected, validate};
}

async function loseReplies(stub: DurableObjectStub, phase: string): Promise<() => void> {
  return runInDurableObject(stub, instance => {
    const original = instance.fetch;
    instance.fetch = async request => {
      const raw = await readJsonBody(request.clone(), 8_192);
      const command = raw.ok && isRecord(raw.value) && isRecord(raw.value["command"]) ? raw.value["command"] : undefined;
      const response = await original.call(instance, request);
      if (command?.["kind"] !== phase) return response;
      await response.body?.cancel();
      return jsonResponse({error: "fake-private-lost-reply-detail"}, 503);
    };
    return () => { instance.fetch = original; };
  });
}

// Real canonical facts/ledgers, parent admission/pump/alarms and replica routes.
// No test-only parent-authority seam and no retries of public fact requests.
describe("canonical publication with durable freshness replicas", () => {
  it("preserves existing facts on explicit opt-in, publishes closed owner cuts, and replays membership without new identities", async () => {
    const f = await fixture();
    const a = await f.join(), b = await f.join();
    expect((await f.control("join", {expectedGeneration: 0})).body["member"]).toBe(a);
    expect((await f.parent()).members).toEqual([a, b]);
    expect((await f.query())["rows"]).toEqual(f.expected(false));
    expect((await f.validate(a, f.initial)).body).toEqual({unchanged: true, snapshotSeq: 1});
    expect((await f.flip()).status).toBe(200);
    const current = await f.query(); expect(current["rows"]).toEqual(f.expected(true));
    for (const member of [a, b]) {
      expect((await f.validate(member, f.initial)).body).toEqual({canonical: true});
      expect((await f.validate(member, current)).body).toEqual({unchanged: true, snapshotSeq: 2});
    }
    await evictDurableObject(f.root); await evictDurableObject(f.head(a));
    expect((await f.validate(a, current)).body).toEqual({unchanged: true, snapshotSeq: 2});
    expect((await f.query(true))["rows"]).toEqual(f.expected(true));
    const state = await f.parent();
    expect(state.operation).toBeNull(); expect(state.view.frontier).toBe(2);
    await runInDurableObject(f.root, (_instance, ctx) => {
      const marker = ctx.storage.sql.exec<{version: number}>("SELECT version FROM poneglyph_schema").one();
      expect(marker.version).toBe(3);
      // This is the exact legacy startup predicate, not an old-binary runtime test.
      expect(() => { if (marker.version !== 2) throw new Error("unsupported g-facade schema marker"); }).toThrow("unsupported");
    });
    for (const prefix of [f.featureRoot, f.credentialRoot]) await runInDurableObject(
      env.GRAPH_SHARDS.getByName(shardObjectName(f.graphId, prefix)), (_instance, ctx) => {
        expect(ctx.storage.sql.exec<{n: number}>("SELECT COUNT(*) AS n FROM fact_log").one().n).toBe(3);
      });
  });

  it.each(["bootstrap", "prepare", "freeze", "activate", "retire"] as const)("recovers a lost %s reply through real actor eviction and alarms", async phase => {
    const f = await fixture();
    const members = phase === "bootstrap" ? [] : [await f.join(), await f.join()];
    const member = members[0] ?? 1, restore = await loseReplies(f.head(member), phase);
    let uncertainTx: string | undefined;
    try {
      if (phase === "bootstrap") expect((await f.control("join", {expectedGeneration: 0})).status).toBe(202);
      else if (phase === "retire") expect((await f.control("retire", {member, expectedGeneration: (await f.parent()).generation})).status).toBe(202);
      else {
        const pending = await f.flip(); expect(pending.status).toBe(503);
        // Failed public writes deliberately omit txId. Reconcile the retained
        // token identity READ-ONLY; never retry or invent a replacement write.
        const ledger = env.GRAPH_LEDGERS.getByName(await tokenLedgerName(f.graphId, "head-flip"));
        const hash = await sha256Hex(`${f.graphId}\u0000head-flip`);
        uncertainTx = await runInDurableObject(ledger, (_instance, ctx) => ctx.storage.sql.exec<{tx_id: string}>(
          "SELECT tx_id FROM client_request_tokens WHERE token_hash = ?", hash).one().tx_id);
      }
      const interrupted = await f.parent(); expect(interrupted.operation).not.toBeNull();
      const changed = phase === "activate";
      expect((await f.query(true))["rows"]).toEqual(f.expected(changed));
      expect(interrupted.view.frontier).toBe(changed ? 2 : 1);
    } finally { restore(); }
    await evictDurableObject(f.head(member)); await evictDurableObject(f.root);
    await runDurableObjectAlarm(f.root);
    expect((await f.parent()).operation).toBeNull();
    if (uncertainTx !== undefined) {
      const ledger = env.GRAPH_LEDGERS.getByName(await transactionCoordinatorName(f.graphId, uncertainTx));
      await runInDurableObject(ledger, (_instance, ctx) => ctx.storage.sql.exec(
        "UPDATE candidate_transactions SET next_recovery_at_ms = 0 WHERE tx_id = ?", uncertainTx));
      await runDurableObjectAlarm(ledger);
      await runInDurableObject(ledger, (_instance, ctx) => expect(ctx.storage.sql.exec<{phase: string}>(
        "SELECT phase FROM candidate_transactions WHERE tx_id = ?", uncertainTx).one().phase).toBe("complete"));
      const current = await f.query(); expect(current["rows"]).toEqual(f.expected(true));
      for (const id of (await f.parent()).members) expect((await f.validate(id, current)).body).toEqual({unchanged: true, snapshotSeq: 2});
      for (const prefix of [f.featureRoot, f.credentialRoot]) await runInDurableObject(
        env.GRAPH_SHARDS.getByName(shardObjectName(f.graphId, prefix)), (_instance, ctx) => {
          expect(ctx.storage.sql.exec<{n: number}>("SELECT COUNT(*) AS n FROM fact_log").one().n).toBe(3);
        });
    } else if (phase === "retire") {
      expect((await f.parent()).members).not.toContain(member);
      expect((await f.validate(member, f.initial)).body).toEqual({canonical: true});
    } else expect((await f.validate(member, f.initial)).body).toEqual({unchanged: true, snapshotSeq: 1});
  });

  it("rolls back the opt-in fence atomically when its marker write fails", async () => {
    const f = await fixture();
    await runInDurableObject(f.root, (_instance, ctx) => ctx.storage.sql.exec(
      "CREATE TRIGGER test_reject_fence BEFORE UPDATE ON poneglyph_schema BEGIN SELECT RAISE(ABORT, 'test fence fault'); END"));
    expect((await f.control("join", {expectedGeneration: 0})).status).toBe(503);
    expect((await f.control("status")).body).toEqual({enabled: false, generation: 0, members: []});
    await runInDurableObject(f.root, (_instance, ctx) => {
      expect(ctx.storage.sql.exec<{version: number}>("SELECT version FROM poneglyph_schema").one().version).toBe(2);
      expect(ctx.storage.kv.get(READ_HEAD_PARENT_KEY)).toBeUndefined();
      ctx.storage.sql.exec("DROP TRIGGER test_reject_fence");
    });
    expect((await f.query(true))["rows"]).toEqual(f.expected(false));
    expect(await f.join()).toBe(1);
  });

  it("rolls back partial vector writes and invalidates its mirror if final freeze publication fails", async () => {
    const f = await fixture(); await f.join(); await f.join();
    await runInDurableObject(f.root, (_instance, ctx) => ctx.storage.sql.exec(
      "CREATE TRIGGER test_reject_publication BEFORE UPDATE ON graph_safe_frontier BEGIN SELECT RAISE(ABORT, 'test publication fault'); END"));
    expect((await f.flip()).status).toBe(503);
    const pending = await f.parent();
    expect(pending.operation?.kind === "publication" && pending.operation.phase).toBe("freeze");
    expect(pending.view.frontier).toBe(1);
    expect((await f.query(true))["rows"]).toEqual(f.expected(false));
    await runInDurableObject(f.root, (_instance, ctx) => {
      for (const prefix of [f.featureRoot, f.credentialRoot]) expect(ctx.storage.sql.exec<{visible_seq: number}>(
        "SELECT visible_seq FROM graph_safe_vector WHERE prefix = ?", prefix).one().visible_seq).toBe(1);
      ctx.storage.sql.exec("DROP TRIGGER test_reject_publication");
    });
    await evictDurableObject(f.root); await runDurableObjectAlarm(f.root);
    expect((await f.parent()).operation).toBeNull();
    expect((await f.query())["rows"]).toEqual(f.expected(true));
    // Reconcile and recover the same durable token/transaction, never resubmit facts.
    const ledger = env.GRAPH_LEDGERS.getByName(await tokenLedgerName(f.graphId, "head-flip"));
    const hash = await sha256Hex(`${f.graphId}\u0000head-flip`);
    await runInDurableObject(ledger, (_instance, ctx) => {
      const tx = ctx.storage.sql.exec<{tx_id: string}>("SELECT tx_id FROM client_request_tokens WHERE token_hash = ?", hash).one();
      ctx.storage.sql.exec("UPDATE candidate_transactions SET next_recovery_at_ms = 0 WHERE tx_id = ?", tx.tx_id);
    });
    await runDurableObjectAlarm(ledger);
  });

  it("publishes real topology epochs through the same freeze/activation protocol", async () => {
    const f = await fixture(true), a = await f.join(), b = await f.join();
    const response = await f.root.fetch("https://root.internal/_split", {method: "POST",
      body: JSON.stringify({graphId: f.graphId, prefix: f.featureRoot, force: true})});
    expect(response.status).toBe(200); await response.body?.cancel();
    const current = await f.query(true); expect(current["rows"]).toEqual(f.expected(false));
    for (const member of [a, b]) {
      expect((await f.validate(member, f.initial)).body).toEqual({canonical: true});
      expect((await f.validate(member, current)).body).toEqual({unchanged: true, snapshotSeq: 1});
    }
    const state = await f.parent(); expect(state.operation).toBeNull();
    expect(state.view.vector.find(owner => owner.prefix === f.featureRoot)?.directoryEpoch).toBe(1);
    expect(state.view.frontier).toBe(2);
  });
});
