import { Miniflare, Log, LogLevel, type MiniflareOptions } from "miniflare";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

// A dedicated conformance runtime: no feeder, benchmark driver, timing samples,
// throughput calculation or performance promotion policy.
export async function startLocal(graphId: string, persistence: string, workerCount: number, token: string = randomUUID(), bundleDirectory: string) {
  const application = await readFile(resolve(bundleDirectory, "application.mjs"), "utf8");
  const database = await readFile(resolve(bundleDirectory, "database.mjs"), "utf8");
  const apps = Array.from({length: workerCount}, (_, i) => `app-${i}`);
  const gateway = `export default {async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/__e2e/")) return env.DATABASE.fetch(request);
    const index = path.split("/")[2];
    if (!env["APP_" + index]) return new Response("not found", {status:404});
    return env["APP_" + index].fetch(request);
  }};`;
  const manifest = (contents: string) => ({mainModule: "index.mjs", modules: {"index.mjs": {type: "esm" as const, contents}}});
  const options: MiniflareOptions = {port: 0, host: "127.0.0.1", log: new Log(LogLevel.ERROR),
    resourcePersistencePath: persistence, telemetry: {enabled: false}, workers: [
      {config: {name: "gateway", manifest: manifest(gateway), compatibilityDate: "2026-10-06",
        env: {...Object.fromEntries(apps.map((name, i) => [`APP_${i}`, {type: "worker" as const, worker: name}])), DATABASE: {type: "worker", worker: "database"}}}},
      {config: {name: "database", manifest: manifest(database), compatibilityDate: "2026-10-06",
        env: {GRAPH_ID: {type: "text", value: graphId}, AUDIT_TOKEN: {type: "text", value: token},
          GRAPH_COORDINATORS: {type: "durable-object", worker: "database", exportName: "InspectionCoordinatorDO"},
          GRAPH_SHARDS: {type: "durable-object", worker: "database", exportName: "InspectionShardDO"},
          TODO_HUBS: {type: "durable-object", worker: "database", exportName: "TodoHubDO"}},
        exports: {InspectionCoordinatorDO: {type: "durable-object", storage: "sqlite"}, InspectionShardDO: {type: "durable-object", storage: "sqlite"}, TodoHubDO: {type: "durable-object", storage: "sqlite"}}}},
      ...apps.map(name => ({config: {name, manifest: manifest(application), compatibilityDate: "2026-10-06",
        env: {CONFORMANCE_TOKEN: {type: "text" as const, value: token}, WORKER_ID: {type: "text" as const, value: name},
          DATABASE: {type: "worker" as const, worker: "database"}}}})),
    ]};
  const mf = new Miniflare(options);
  try {
    const url = await mf.ready;
    const database = databaseControl(() => url.href);
    return {database, close: () => mf.dispose(), graphId, token, endpoints: apps.map((_, i) => new URL(`/apps/${i}`, url).href)};
  } catch (error) {await mf.dispose(); throw error;}
}
export function databaseControl(endpoint: () => string): LocalRuntime["database"] {
  return {fetch: (input, init) => {
    const source = new URL(String(input));
    return fetch(new URL(source.pathname + source.search, endpoint()), init);
  }};
}
export type LocalRuntime = Readonly<{
  database: {fetch(input: string | URL, init?: RequestInit): Promise<Response>};
  close(): Promise<void>;
  crashAndRestart?: () => Promise<object>;
  graphId: string; token: string; endpoints: readonly string[];
}>;
