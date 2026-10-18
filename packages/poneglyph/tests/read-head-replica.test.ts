import {evictDurableObject, runInDurableObject} from "cloudflare:test";
import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import {parseGraphId} from "../src/domain/graph-id.js";
import {isRecord} from "../src/domain/result.js";
import {TREE_PREFIXES, treeForKey} from "../src/storage/forest.js";
import {jsonResponse, readJsonBody} from "../src/storage/http.js";
import {coordinatorObjectName, virtualKeyForEntity} from "../src/storage/keys.js";
import {
  acknowledgeReadHeadDelivery, beginReadHeadJoin, beginReadHeadPublication, beginReadHeadRetirement,
  createReadHeadParent, pendingReadHeadDeliveries, type ReadHeadDelivery,
} from "../src/storage/read-head-parent.js";
import {parseReadHeadReplicaName, readHeadReplicaName, READ_HEAD_STATE_KEY} from "../src/storage/read-head-placement.js";
import {parseReadHeadCommand, parseReadHeadView} from "../src/storage/read-head-state.js";

const query = 'test:value("test:point", Value)';
function view(frontier: number) {
  return parseReadHeadView({frontier, vector: TREE_PREFIXES.map(prefix => ({prefix, snapshotSeq: frontier, directoryEpoch: 0}))});
}
async function fixture() {
  const graph = parseGraphId(`test-head-role-${crypto.randomUUID()}`);
  if (!graph.ok) throw new Error("invalid fixture graph");
  const graphId = graph.value, root = env.GRAPH_FACADES.getByName(coordinatorObjectName(graphId));
  let parent = createReadHeadParent(graphId, view(0));
  let mode: "normal" | "deny" | "unavailable" | "malformed" = "normal";
  let hold: {kind: string; started: () => void; released: Promise<void>} | undefined;
  const head = (member: number) => env.GRAPH_FACADES.getByName(readHeadReplicaName(graphId, member));
  // Test-only authority seam. Head handlers, storage and inter-DO fetch are real;
  // production canonical publication/authorization is NOT integrated by this test.
  const restore = await runInDurableObject(root, instance => {
    const original = instance.fetch;
    instance.fetch = async request => {
      if (new URL(request.url).pathname !== "/_read-head-authorize") return original.call(instance, request);
      if (mode === "unavailable") return jsonResponse({error: "fake-private-authority-detail"}, 503);
      if (mode === "malformed") return jsonResponse({authorized: true, extra: "not-permission"});
      const raw = await readJsonBody(request, 8_192);
      if (!raw.ok || !isRecord(raw.value) || typeof raw.value["member"] !== "number") return jsonResponse({authorized: false});
      const delivery = {member: raw.value["member"], command: parseReadHeadCommand(raw.value["command"])};
      const authorized = mode === "normal" && acknowledgeReadHeadDelivery(parent, delivery, "applied") !== parent;
      const gate = hold;
      if (gate !== undefined && gate.kind === delivery.command.kind) {
        hold = undefined; gate.started(); await gate.released;
      }
      return jsonResponse({authorized});
    };
    return () => { instance.fetch = original; };
  });
  const send = async (delivery: ReadHeadDelivery) => {
    const response = await head(delivery.member).fetch("https://head.internal/_read-head-command", {
      method: "POST", body: JSON.stringify({member: delivery.member, command: delivery.command}),
    });
    const body: unknown = await response.json();
    return {status: response.status, body};
  };
  const step = async (delivery = pendingReadHeadDeliveries(parent)[0]!) => {
    const result = await send(delivery);
    expect(result.status).toBe(200);
    if (!isRecord(result.body)) throw new Error("invalid fixture command reply");
    expect(["applied", "already-applied"]).toContain(result.body["outcome"]);
    parent = acknowledgeReadHeadDelivery(parent, delivery, result.body["outcome"]);
    return result;
  };
  const settle = async () => { while (parent.operation !== null) await step(); };
  const join = async () => { parent = beginReadHeadJoin(parent); const member = parent.generation; await settle(); return member; };
  const scope = treeForKey(await virtualKeyForEntity(graphId, "test:point"));
  const validate = async (member: number, frontier: number, patch: Record<string, unknown> = {}) => {
    const response = await head(member).fetch("https://head.internal/_read-head-validate", {method: "POST", body: JSON.stringify({
      graphId, member, query, knownSnapshot: view(frontier).vector.filter(owner => owner.prefix === scope), ...patch,
    })});
    const body: unknown = await response.json();
    return {status: response.status, body};
  };
  return {
    graphId, root, head, join, send, step, settle, validate, restore,
    parent: () => parent, mode: (value: typeof mode) => { mode = value; },
    publication: (frontier: number) => { parent = beginReadHeadPublication(parent, view(frontier)); },
    retire: (member: number) => { parent = beginReadHeadRetirement(parent, member); },
    beginJoin: () => { parent = beginReadHeadJoin(parent); return pendingReadHeadDeliveries(parent)[0]!; },
    holdNextAuthorization: (kind: string) => {
      let signal = () => {}, release = () => {};
      const started = new Promise<void>(resolve => { signal = resolve; });
      const released = new Promise<void>(resolve => { release = resolve; });
      hold = {kind, started: signal, released};
      return {started, release};
    },
  };
}

describe("metadata-only freshness role in existing facade namespace", () => {
  it("parses reserved physical names exactly and rejects malformed role/version/member identities", () => {
    const graph = parseGraphId("test-placement");
    if (!graph.ok) throw new Error("invalid fixture graph");
    expect(parseReadHeadReplicaName(coordinatorObjectName(graph.value))).toBeNull();
    const sameAsRole = parseGraphId("read-head");
    if (!sameAsRole.ok) throw new Error("invalid fixture graph");
    expect(parseReadHeadReplicaName(coordinatorObjectName(sameAsRole.value))).toBeNull();
    expect(parseReadHeadReplicaName(undefined)).toBeNull();
    expect(parseReadHeadReplicaName(readHeadReplicaName(graph.value, 17))).toEqual({graphId: graph.value, member: 17});
    for (const name of ["graph:test-placement:read-head:v8:17", "graph:test-placement:read-head:v09:17",
      "graph:test-placement:read-head:v9:017", "graph:test-placement:read-head:v9:0",
      "graph:BAD:read-head:v9:1", "graph:test-placement:read-head:v9:9007199254740992",
    ]) expect(() => parseReadHeadReplicaName(name)).toThrow();
  });

  it("persists admitted bootstrap/activation and validates only the query's exact owner scope after eviction", async () => {
    const f = await fixture();
    try {
      const pending = f.beginJoin(), member = pending.member;
      await f.step(pending);
      expect(await f.validate(member, 0)).toEqual({status: 200, body: {canonical: true}});
      await f.settle();
      expect(await f.validate(member, 0)).toEqual({status: 200, body: {unchanged: true, snapshotSeq: 0}});
      await evictDurableObject(f.head(member));
      const byId = env.GRAPH_FACADES.get(env.GRAPH_FACADES.idFromString(f.head(member).id.toString()));
      const byIdResponse = await byId.fetch("https://head.internal/_read-head-validate", {method: "POST", body: JSON.stringify({
        graphId: f.graphId, member, query: "test:value(Entity, Value)", knownSnapshot: view(0).vector,
      })});
      expect(byIdResponse.status).toBe(200);
      expect(await byIdResponse.json()).toEqual({unchanged: true, snapshotSeq: 0});
      expect(await f.validate(member, 0)).toEqual({status: 200, body: {unchanged: true, snapshotSeq: 0}});
      expect((await f.validate(member, 0, {query: "test:value(Entity, Value)"})).status).toBe(400);
      expect((await f.validate(member, 0, {graphId: "another-graph"})).status).toBe(400);
      expect((await f.validate(member, 0, {member: member + 1})).status).toBe(400);
      for (const path of ["/_publish-vector", "/_query-read-cut", `/v1/graphs/${f.graphId}/transactions`]) {
        const response = await f.head(member).fetch(`https://head.internal${path}`, {method: "POST", body: "{}"});
        expect(response.status).toBe(404); await response.body?.cancel();
      }
    } finally { f.restore(); }
  });

  it("requires exact affirmative authority and never leaks its malformed or unavailable response", async () => {
    const f = await fixture();
    try {
      const delivery = f.beginJoin();
      f.mode("deny");
      expect(await f.send(delivery)).toEqual({status: 200, body: {outcome: "conflict"}});
      for (const mode of ["unavailable", "malformed"] as const) {
        f.mode(mode);
        expect(await f.send(delivery)).toEqual({status: 503, body: {error: "read-head authority is unavailable", retryable: true}});
      }
      await runInDurableObject(f.head(delivery.member), (_instance, ctx) => expect(ctx.storage.kv.get(READ_HEAD_STATE_KEY)).toBeUndefined());
      f.mode("normal"); await f.settle();
      expect((await f.validate(delivery.member, 0)).body).toEqual({unchanged: true, snapshotSeq: 0});
    } finally { f.restore(); }
  });

  it("fences real head requests across publication, duplicate freeze, permanent retirement and stale routes", async () => {
    const f = await fixture();
    try {
      const a = await f.join(), b = await f.join();
      f.publication(1);
      while (pendingReadHeadDeliveries(f.parent())[0]?.command.kind === "prepare") await f.step();
      const freezes = pendingReadHeadDeliveries(f.parent());
      for (const delivery of freezes) await f.step(delivery);
      for (const member of [a, b]) expect((await f.validate(member, 0)).body).toEqual({canonical: true});
      await f.settle();
      expect((await f.send(freezes[0]!)).body).toEqual({outcome: "already-applied"});
      for (const member of [a, b]) {
        expect((await f.validate(member, 0)).body).toEqual({canonical: true});
        expect((await f.validate(member, 1)).body).toEqual({unchanged: true, snapshotSeq: 1});
      }
      f.retire(a); await f.settle(); await evictDurableObject(f.head(a));
      expect((await f.send(freezes[0]!)).body).toEqual({outcome: "stale"});
      expect((await f.validate(a, 1)).body).toEqual({canonical: true});
    } finally { f.restore(); }
  });

  it("rechecks current head state after delayed authority rather than installing its pre-await proposal", async () => {
    const f = await fixture();
    let release = () => {};
    let pending: ReturnType<typeof f.send> | undefined;
    try {
      const member = await f.join(); f.publication(1); await f.step();
      const freeze = pendingReadHeadDeliveries(f.parent())[0]!;
      expect(freeze.command.kind).toBe("freeze");
      const held = f.holdNextAuthorization("freeze"); release = held.release;
      pending = f.send(freeze); await held.started;
      // A second admitted delivery finishes freeze and activation while the
      // first authority reply is delayed. Releasing it must NOT refreeze.
      await f.step(freeze); await f.settle();
      expect((await f.validate(member, 1)).body).toEqual({unchanged: true, snapshotSeq: 1});
      release();
      expect((await pending).body).toEqual({outcome: "already-applied"});
      pending = undefined;
      await evictDurableObject(f.head(member));
      expect((await f.validate(member, 1)).body).toEqual({unchanged: true, snapshotSeq: 1});
    } finally { release(); await pending; f.restore(); }
  });
});
