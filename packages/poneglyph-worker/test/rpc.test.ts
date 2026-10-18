import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";

// Finite native RPC + real canonical SQLite, no mocked RpcTarget/transport.
test("graph-scoped native RPC preserves writes/results and denies ungranted capabilities", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "poneglyph-service-test-"));
  let runtime: Miniflare | undefined;
  let complete = false;
  try {
    await build({ absWorkingDir: resolve(import.meta.dirname, ".."), entryPoints: { service: "src/index.ts", driver: "test/driver.ts" }, outdir: directory, outExtension: { ".js": ".mjs" }, bundle: true, format: "esm", platform: "browser", target: "es2024", external: ["cloudflare:*", "node:*"], conditions: ["workerd", "worker", "browser"] });
    const manifest = async (name: string) => ({ mainModule: "index.mjs", modules: { "index.mjs": { type: "esm" as const, contents: await readFile(resolve(directory, `${name}.mjs`), "utf8") } } });
    const binding = (props?: Record<string, unknown>) => ({ type: "worker" as const, worker: "service", ...(props === undefined ? {} : { props }) });
    runtime = new Miniflare({ host: "127.0.0.1", port: 0, resourcePersistencePath: resolve(directory, "state"), telemetry: { enabled: false }, log: new Log(LogLevel.WARN), workers: [
      { config: { name: "driver", manifest: await manifest("driver"), compatibilityDate: "2026-10-13", compatibilityFlags: ["nodejs_compat"], env: { READER: binding({ clientId: "reader" }), WRITER: binding({ clientId: "writer" }), UNKNOWN: binding({ clientId: "unknown" }), MISSING: binding(), MALFORMED: binding({ clientId: "writer", permissions: ["write"] }), NO_STORAGE: { ...binding({ clientId: "reader" }), worker: "no-storage" } } } },
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
    for (const path of ["/unknown", "/missing", "/malformed", "/forbidden-graph", "/write", "/deny-before-storage"]) {
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
