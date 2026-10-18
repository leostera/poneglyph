import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import { treeForKey } from "../../poneglyph/src/storage/forest.js";
import { virtualKeyForEntity } from "../../poneglyph/src/storage/keys.js";
import { isRecord } from "../../poneglyph/src/domain/result.js";
import { parseReadHeadParent } from "../../poneglyph/src/storage/read-head-parent.js";
import { parseReadHeadState } from "../../poneglyph/src/storage/read-head-state.js";
import { verifyReadHeadRouting } from "./read-head-rpc.js";

// Finite native RPC + real canonical SQLite, no mocked RpcTarget/transport.
test("graph-scoped native RPC preserves writes/results and denies ungranted capabilities", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "poneglyph-service-test-"));
  let runtime: Miniflare | undefined;
  let complete = false;
  try {
    await build({ absWorkingDir: resolve(import.meta.dirname, ".."), entryPoints: { service: "test/cache-test-service.ts", driver: "test/driver.ts" }, outdir: directory, outExtension: { ".js": ".mjs" }, bundle: true, format: "esm", platform: "browser", target: "es2024", external: ["cloudflare:*", "node:*"], conditions: ["workerd", "worker", "browser"] });
    const manifest = async (name: string) => ({ mainModule: "index.mjs", modules: { "index.mjs": { type: "esm" as const, contents: await readFile(resolve(directory, `${name}.mjs`), "utf8") } } });
    const binding = (props?: Record<string, unknown>) => ({ type: "worker" as const, worker: "service", ...(props === undefined ? {} : { props }) });
    runtime = new Miniflare({ host: "127.0.0.1", port: 0, resourcePersistencePath: resolve(directory, "state"), telemetry: { enabled: false }, log: new Log(LogLevel.WARN), workers: [
      { config: { name: "driver", manifest: await manifest("driver"), compatibilityDate: "2026-10-13", compatibilityFlags: ["nodejs_compat"], env: { TEST_FACADE: {type: "durable-object", worker: "service", exportName: "GraphCoordinatorDO"}, READER: binding({ clientId: "reader" }), WRITER: binding({ clientId: "writer" }), UNKNOWN: binding({ clientId: "unknown" }), MISSING: binding(), MALFORMED: binding({ clientId: "writer", permissions: ["write"] }), NO_STORAGE: { ...binding({ clientId: "reader" }), worker: "no-storage" } } } },
      { config: { name: "service", manifest: await manifest("service"), compatibilityDate: "2026-10-13", compatibilityFlags: ["nodejs_compat"], env: {
        GRAPH_FACADES: { type: "durable-object", worker: "service", exportName: "GraphCoordinatorDO" },
        GRAPH_LEDGERS: { type: "durable-object", worker: "service", exportName: "GraphLedgerDO" },
        GRAPH_TREES: { type: "durable-object", worker: "service", exportName: "GraphTreeDO" },
        GRAPH_SHARDS: { type: "durable-object", worker: "service", exportName: "GraphShardDO" },
        GRAPH_GRANTS: { type: "json", value: { reader: { example: ["read"] }, writer: { example: ["read", "write"], other: ["read", "write"] } } },
      }, exports: { GraphCoordinatorDO: { type: "durable-object", storage: "sqlite" }, GraphLedgerDO: { type: "durable-object", storage: "sqlite" }, GraphTreeDO: { type: "durable-object", storage: "sqlite" }, GraphShardDO: { type: "durable-object", storage: "sqlite" } } } },
      // No storage bindings at all: handle acquisition and denial must still
      // succeed, proving neither path touches durable state.
      { config: { name: "no-storage", manifest: await manifest("service"), compatibilityDate: "2026-10-13", compatibilityFlags: ["nodejs_compat"], env: { GRAPH_GRANTS: { type: "json", value: { reader: { example: ["read"] } } } } } },
    ] });
    await runtime.ready;
    const active = runtime;
    const call = async (path: string) => { const response = await active.dispatchFetch(`https://driver.test${path}`); return { status: response.status, body: await response.json() }; };
    for (const path of ["/unknown", "/missing", "/malformed", "/forbidden-graph", "/write", "/deny-before-storage", "/one-shot-denied", "/one-shot-unknown"]) {
      assert.deepEqual(await call(path), { status: 400, body: { name: "GraphAuthorizationError", message: "Graph access denied" } });
    }
    assert.deepEqual(await call("/identity"), { status: 200, body: { id: "example" } });
    assert.deepEqual(await call("/acquire-only"), { status: 200, body: { id: "example" } });
    const forged = await active.dispatchFetch("https://driver.test/raw-selection", { method: "POST", body: JSON.stringify({ graphId: "example", clientId: "writer", permissions: ["write"] }) });
    assert.equal(forged.status, 400);
    assert.deepEqual(await forged.json(), { name: "GraphAuthorizationError", message: "Graph access denied" });
    const badWrite = await call("/bad-write");
    assert.equal(badWrite.status, 400);
    assert.ok(typeof badWrite.body === "object" && badWrite.body !== null && "name" in badWrite.body);
    assert.equal(badWrite.body.name, "PoneglyphInputError");
    const concurrent = await call("/parallel-seed");
    assert.equal(concurrent.status, 200);
    assert.ok(Array.isArray(concurrent.body));
    assert.equal(concurrent.body.length, 2);
    assert.deepEqual(concurrent.body[0], concurrent.body[1], "simultaneous identical token requests share one durable outcome");
    assert.match(String((concurrent.body[0] as {txId: unknown}).txId), /^poneglyph:tx:/);
    const first = await call("/seed");
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, concurrent.body[0]); // later request-token replay returns the original witness
    const title = await call("/query");
    assert.equal(title.status, 200, JSON.stringify(title.body));
    assert.ok(typeof title.body === "object" && title.body !== null && "rows" in title.body);
    assert.deepEqual(title.body.rows, [
      { E: { type: "string", value: "test:e" }, T: { type: "string", value: "hello" } },
      { E: { type: "string", value: "test:e" }, T: { type: "string", value: "hello" } },
    ]);
    assert.equal((title.body as unknown as {metrics: {treeReadLeaseAcquisitions: number}}).metrics.treeReadLeaseAcquisitions, 16,
      "unbound Worker queries acquire the complete exact read vector");
    const integer = await call("/integer");
    assert.ok(typeof integer.body === "object" && integer.body !== null && "rows" in integer.body);
    assert.deepEqual(integer.body.rows, [{ Value: { type: "integer", value: "9007199254740993" } }]);
    assert.equal((integer.body as unknown as {metrics: {treeReadLeaseAcquisitions: number}}).metrics.treeReadLeaseAcquisitions, 1,
      "a single-entity Worker query acquires only its exact owner lease");
    const pointed = await call("/pointed-join");
    assert.equal(pointed.status, 200, JSON.stringify(pointed.body));
    assert.ok(typeof pointed.body === "object" && pointed.body !== null && "rows" in pointed.body && "metrics" in pointed.body && "snapshotSeq" in pointed.body);
    assert.deepEqual(pointed.body.rows, [
      {T: {type: "string", value: "hello"}, S: {type: "string", value: "active"}},
      {T: {type: "string", value: "hello"}, S: {type: "string", value: "active"}},
    ]);
    const oneShot = await call("/one-shot");
    assert.equal(oneShot.status, 200, JSON.stringify(oneShot.body));
    assert.ok(typeof oneShot.body === "object" && oneShot.body !== null && "rows" in oneShot.body && "snapshotSeq" in oneShot.body && "metrics" in oneShot.body);
    assert.deepEqual(oneShot.body.rows, pointed.body.rows);
    assert.equal(oneShot.body.snapshotSeq, pointed.body.snapshotSeq);
    assert.equal((oneShot.body.metrics as {cacheHits: number}).cacheHits, 1, "fresh authoritative validation enables completed Worker result reuse");
    assert.equal((oneShot.body.metrics as {treeReadLeaseAcquisitions: number}).treeReadLeaseAcquisitions, 0);
    assert.deepEqual(await call("/one-shot-unknown"), {status: 400, body: {name: "GraphAuthorizationError", message: "Graph access denied"}},
      "warming another principal's graph cache never supplies authority");
    assert.equal((await call("/change-pointed")).status, 200);
    const changed = await call("/one-shot");
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.ok(typeof changed.body === "object" && changed.body !== null && "rows" in changed.body && "metrics" in changed.body);
    assert.deepEqual(changed.body.rows, [
      {T: {type: "string", value: "hello"}, S: {type: "string", value: "inactive"}},
      {T: {type: "string", value: "hello"}, S: {type: "string", value: "inactive"}},
    ], "a selected-owner write acknowledged before a cache check cannot return stale rows");
    assert.equal((changed.body.metrics as {cacheHits: number}).cacheHits, 0);
    const changedWarm = await call("/one-shot");
    assert.ok(typeof changedWarm.body === "object" && changedWarm.body !== null && "rows" in changedWarm.body && "metrics" in changedWarm.body);
    assert.deepEqual(changedWarm.body.rows, changed.body.rows);
    assert.equal((changedWarm.body.metrics as {cacheHits: number}).cacheHits, 1);
    assert.equal((await call("/cache-unavailable")).status, 200);
    const unavailableCache = await call("/one-shot");
    assert.equal(unavailableCache.status, 400);
    assert.deepEqual(unavailableCache.body, {name: "PoneglyphRequestError", message: "Graph read failed; a complete answer is unavailable", status: 503, retryable: true},
      "a warm result cannot bypass unavailable freshness authority or expose backend details");
    assert.equal((await call("/cache-malformed")).status, 200);
    const malformedCache = await call("/one-shot");
    assert.equal(malformedCache.status, 400);
    assert.deepEqual(malformedCache.body, {name: "PoneglyphProtocolError", message: "Graph did not return a valid complete read answer"});
    assert.equal((await call("/cache-reset")).status, 200);
    const restoredCache = await call("/one-shot");
    assert.equal(restoredCache.status, 200);
    assert.ok(typeof restoredCache.body === "object" && restoredCache.body !== null && "rows" in restoredCache.body);
    assert.deepEqual(restoredCache.body.rows, changed.body.rows);
    const forgedQuery = await active.dispatchFetch("https://driver.test/one-shot-forged", {method: "POST", body: JSON.stringify({graphId: "example", query: "test:title(E, T)", permissions: ["write"]})});
    assert.equal(forgedQuery.status, 400);
    const owners = new Set(await Promise.all(["test:e", "test:e2"].map(async entity => treeForKey(await virtualKeyForEntity("example", entity)))));
    assert.equal((pointed.body.metrics as {treeReadLeaseAcquisitions: number}).treeReadLeaseAcquisitions, owners.size,
      "compound pointed queries lease exactly their owner union without losing duplicate rows");
    const schema = await call("/schema");
    assert.equal(schema.status, 200);
    assert.ok(typeof schema.body === "object" && schema.body !== null && "fields" in schema.body && "snapshotVector" in schema.body);
    const observed = schema.body as {fields: readonly {field: string; valueTags: readonly string[]}[]; snapshotVector: readonly unknown[]};
    assert.equal(observed.snapshotVector.length, 16);
    assert.ok(observed.fields.some(field => field.field === "test:title" && field.valueTags.includes("text")));
    const invalid = await call("/bad-query");
    assert.equal(invalid.status, 400);
    assert.ok(typeof invalid.body === "object" && invalid.body !== null && "name" in invalid.body);
    assert.equal(invalid.body.name, "PoneglyphInputError");
    assert.equal((await call("/second")).status, 200); // same ID, different graph/payload
    const isolated = await call("/query"); // no cross-graph membership leak
    assert.ok(typeof isolated.body === "object" && isolated.body !== null && "rows" in isolated.body);
    assert.deepEqual(isolated.body.rows, [
      { E: { type: "string", value: "test:e" }, T: { type: "string", value: "hello" } },
      { E: { type: "string", value: "test:e" }, T: { type: "string", value: "hello" } },
    ]);
    const conflict = await call("/conflict");
    assert.equal(conflict.status, 400);
    assert.ok(typeof conflict.body === "object" && conflict.body !== null && "status" in conflict.body && "retryable" in conflict.body);
    assert.equal(conflict.body.status, 409); assert.equal(conflict.body.retryable, false);
    const post = async (path: string, body: unknown) => {
      const response = await active.dispatchFetch(`https://driver.test${path}`, {method: "POST", body: JSON.stringify(body)});
      return {status: response.status, body: await response.json()};
    };
    const writeState = async (head = false) => {
      const result = await call(head ? "/head-state" : "/write-state");
      assert.equal(result.status, 200);
      assert.ok(isRecord(result.body));
      assert.ok(typeof result.body["admissionCalls"] === "number");
      assert.ok(typeof result.body["publicationCalls"] === "number");
      return {admissionCalls: result.body["admissionCalls"], publicationCalls: result.body["publicationCalls"],
        parent: result.body["parent"] === null ? null : parseReadHeadParent(result.body["parent"]),
        head: result.body["head"] === null ? null : parseReadHeadState(result.body["head"])};
    };
    const marker = (entity: string) => ({source: "test:write-scaling", entity, field: "test:scale-marker", value: {type: "text", value: "present"}});
    const readMarker = async (entity: string) => {
      const result = await post("/one-shot-read", {graphId: "example", query: `test:scale-marker(${JSON.stringify(entity)}, Value)`});
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.ok(isRecord(result.body));
      return result.body["rows"];
    };
    const present = [{Value: {type: "string", value: "present"}}];
    const denied = {status: 400, body: {name: "GraphAuthorizationError", message: "Graph access denied"}};
    for (const path of ["/one-shot-write-unknown", "/one-shot-write-missing", "/one-shot-write-malformed"]) {
      assert.deepEqual(await call(path), denied);
    }
    assert.deepEqual(await post("/one-shot-write-denied", {graphId: "example", facts: null, clientRequestToken: ""}), denied,
      "read-only one-shot writes deny before malformed facts/options or absent storage bindings");
    assert.deepEqual(await post("/one-shot-write", {graphId: "ungranted", facts: []}), denied);
    const beforeInvalid = await writeState();
    for (const input of [null, [], {}, {graphId: "example"}, {graphId: "example", facts: null},
      ...["clientId", "permissions", "txId", "options", "signal"].map(key => ({graphId: "example", facts: [], [key]: "forged"})),
      {graphId: "example", facts: [], clientRequestToken: ""}]) {
      const invalidWrite = await post("/one-shot-write", input);
      assert.equal(invalidWrite.status, 400);
      assert.ok(isRecord(invalidWrite.body));
      assert.equal(invalidWrite.body["name"], "PoneglyphInputError");
    }
    assert.deepEqual(await writeState(), beforeInvalid, "invalid or denied calls cannot publish");
    assert.deepEqual(await call("/one-shot-write-replay"), first, "one-shot and handle writes preserve the same graph-scoped token outcome");

    // Separate incoming invocations, disjoint owners, all responses settled.
    // This finite fixture is not a throughput measurement or global scheduler.
    const distinctOwners = new Map<string, string>();
    for (let i = 0; distinctOwners.size < 4 && i < 1_000; i++) {
      const entity = `test:independent-${i}`;
      distinctOwners.set(treeForKey(await virtualKeyForEntity("example", entity)), entity);
    }
    assert.equal(distinctOwners.size, 4);
    const entities = [...distinctOwners.values()];
    const settled = await Promise.allSettled(entities.map(entity => post("/one-shot-write", {
      graphId: "example", facts: [marker(entity)], clientRequestToken: `test:independent:${entity}`,
    })));
    for (const result of settled) {
      assert.equal(result.status, "fulfilled");
      assert.equal(result.value.status, 200, JSON.stringify(result.value.body));
      assert.ok(isRecord(result.value.body));
      assert.deepEqual(Object.keys(result.value.body), ["txId"]);
    }
    for (const entity of entities) assert.deepEqual(await readMarker(entity), present);
    const noToken = await post("/one-shot-write", {graphId: "example", facts: [marker("test:untokenized")]});
    assert.equal(noToken.status, 200, JSON.stringify(noToken.body));
    assert.deepEqual(await readMarker("test:untokenized"), present);

    const unknownDelivery = {status: 400, body: {name: "PoneglyphRequestError", message: "Graph write failed; delivery may be unknown", status: 503, retryable: true}};
    const blocked = {graphId: "example", facts: [marker("test:publication-blocked")], clientRequestToken: "test:publication-blocked"};
    assert.equal((await call("/publication-blocked")).status, 200);
    assert.deepEqual(await post("/one-shot-write", blocked), unknownDelivery,
      "direct ledger admission cannot acknowledge before canonical publication or expose backend details/transaction identity");
    assert.deepEqual(await readMarker("test:publication-blocked"), [], "unpublished owner revisions remain invisible");
    assert.equal((await call("/publication-reset")).status, 200);
    // Explicit test-controlled replay of the SAME token/facts, never a fresh ID.
    const recovered = await post("/one-shot-write", blocked);
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.deepEqual(await post("/one-shot-write", blocked), recovered);
    assert.deepEqual(await readMarker("test:publication-blocked"), present);

    const lost = {graphId: "example", facts: [marker("test:publication-lost")], clientRequestToken: "test:publication-lost"};
    assert.equal((await call("/publication-lost")).status, 200);
    assert.deepEqual(await post("/one-shot-write", lost), unknownDelivery);
    assert.deepEqual(await readMarker("test:publication-lost"), present, "a failed publication reply does not establish abort");
    const reconciled = await post("/one-shot-write", lost);
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
    assert.deepEqual(await post("/one-shot-write", lost), reconciled);
    assert.deepEqual(await readMarker("test:publication-lost"), present);

    assert.deepEqual(await call("/enable-head"), {status: 200, body: {member: 1, generation: 1, pending: false}});
    const beforeHead = await writeState();
    assert.ok(beforeHead.parent !== null);
    assert.equal((await post("/one-shot-write", {graphId: "example", facts: [marker("test:head-publication")], clientRequestToken: "test:head-publication"})).status, 200);
    const afterHead = await writeState(), replica = await writeState(true);
    assert.ok(afterHead.parent !== null && replica.head?.mode === "serving");
    assert.equal(afterHead.parent.operation, null);
    assert.ok(afterHead.parent.view.frontier > beforeHead.parent.view.frontier);
    assert.deepEqual(replica.head.view, afterHead.parent.view, "direct admission must still publish and activate an opted-in replica before acknowledgement");
    assert.deepEqual(await readMarker("test:head-publication"), present);
    assert.equal(afterHead.admissionCalls, 0, "both RPC write APIs bypass the facade's deliberately failing public admission route");
    assert.ok(afterHead.publicationCalls >= 10, "the canonical publication authority remains mandatory");
    await verifyReadHeadRouting(active, entities);
    const service = await active.getWorker("service");
    for (const path of ["/v1/graphs/example/query", "/v1/graphs/example/transactions", "/_transact", "/__e2e/inspect"]) {
      const denied = await service.fetch(`https://private.test${path}`, { method: "POST", body: "{}" });
      assert.equal(denied.status, 404); await denied.text();
    }
    complete = true;
  } finally {
    if (runtime !== undefined) await runtime.dispose();
    if (complete) await rm(directory, { recursive: true, force: true });
    else console.error(JSON.stringify({ event: "incomplete-service-test", directory }));
  }
});
