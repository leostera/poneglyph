import { Miniflare, Log, LogLevel, type MiniflareOptions } from "miniflare";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ROOT } from "./build.js";

export async function startLocal(graphId: string, persistence: string, workerCount: number, token = randomUUID(), bundleDirectory = resolve(ROOT, ".build")) {
  const apps = Array.from({ length: workerCount }, (_, i) => `app-${i}`);
  const gateway = `export default { async fetch(request, env) {
    const url = new URL(request.url);
    const match = /^\\/apps\\/(\\d+)(\\/.*)$/.exec(url.pathname);
    if (!match || !env["APP_" + match[1]]) return new Response("not found", {status:404});
    url.pathname = match[2]; return env["APP_" + match[1]].fetch(new Request(url, request));
  }};`;
  const application = await readFile(resolve(bundleDirectory, "application.mjs"), "utf8");
  const databaseScript = await readFile(resolve(bundleDirectory, "database.mjs"), "utf8");
  const manifest = (contents: string) => ({ mainModule: "index.mjs", modules: { "index.mjs": { type: "esm" as const, contents } } });
  const options: MiniflareOptions = {
    port: 0, host: "127.0.0.1", log: new Log(LogLevel.ERROR), resourcePersistencePath: persistence,
    telemetry: { enabled: false },
    workers: [
      { config: { name: "gateway", manifest: manifest(gateway), compatibilityDate: "2026-10-06",
        env: Object.fromEntries(apps.map((name, i) => [`APP_${i}`, { type: "worker" as const, worker: name }])) } },
      { config: { name: "database", manifest: manifest(databaseScript), compatibilityDate: "2026-10-06",
        env: { GRAPH_ID: { type: "text", value: graphId }, AUDIT_TOKEN: { type: "text", value: token },
          GRAPH_COORDINATORS: { type: "durable-object", worker: "database", exportName: "BenchCoordinatorDO" },
          GRAPH_SHARDS: { type: "durable-object", worker: "database", exportName: "BenchShardDO" },
          TODO_HUBS: { type: "durable-object", worker: "database", exportName: "TodoHubDO" } },
        exports: { BenchCoordinatorDO: { type: "durable-object", storage: "sqlite" }, BenchShardDO: { type: "durable-object", storage: "sqlite" }, TodoHubDO: { type: "durable-object", storage: "sqlite" } } } },
      ...apps.map(name => ({ config: { name, manifest: manifest(application), compatibilityDate: "2026-10-06",
        env: { GRAPH_ID: { type: "text" as const, value: graphId }, BENCH_TOKEN: { type: "text" as const, value: token },
          WORKER_ID: { type: "text" as const, value: name }, DATABASE: { type: "worker" as const, worker: "database" } } } })),
    ],
  };
  const mf = new Miniflare(options);
  let url: URL;
  try { url = await mf.ready; } catch (error) { await mf.dispose(); throw error; }
  const database = await mf.getWorker("database");
  return {
    mf, token, graphId,
    endpoints: apps.map((_, i) => new URL(`/apps/${i}/facts`, url).href),
    async waitForIdle() {
      const deadline = Date.now() + 120000;
      let empty = 0;
      while (Date.now() < deadline) {
        const counts = await Promise.all(apps.map(async name => {
          const app = await mf.getWorker(name);
          const response = await app.fetch("https://activity.internal/__bench/activity", { headers: { authorization: `Bearer ${token}` } });
          const activity = await response.json() as { inFlight?: unknown };
          if (!response.ok || typeof activity.inFlight !== "number") throw new Error("invalid local activity probe");
          return activity.inFlight;
        }));
        empty = counts.every(count => count === 0) ? empty + 1 : 0;
        if (empty === 2) return;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error("local application requests did not drain before audit");
    },
    async audit(path: string) {
      const response = await database.fetch(`https://audit.internal/__bench/${path}`, { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`audit failed: ${response.status} ${await response.text()}`);
      return response.json();
    },
    async query(query: string) {
      const response = await database.fetch(`https://database.internal/v1/graphs/${graphId}/query`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }),
      });
      if (!response.ok) throw new Error(`query failed: ${response.status} ${await response.text()}`);
      return response.json();
    },
  };
}
export type LocalRuntime = Awaited<ReturnType<typeof startLocal>>;
