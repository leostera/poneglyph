// Local, offline preview of the browser playground against real canonical
// SQLite actors. Serves the built client (run `bun run build` first), simulates
// the Access identity, and loads the v5 overlay plus a slice of pinned base
// batches into a temporary graph. No Cloudflare credentials or network.
//
//   bun run preview:local [-- --base-batches=40 --port=8790]
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, relative, resolve } from "node:path";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { ACCESS_AUDIENCE, API_RATE_LIMIT, WRITE_RATE_LIMIT } from "../src/api.js";
import { parseApprovedBatch, parseImportPlan } from "../src/import-contract.js";
import { RATE_LIMIT } from "../src/rate-limit.js";
import { COMPATIBILITY_DATE, GRAPH_ID } from "../src/runtime.js";

const site = resolve(import.meta.dirname, "..");
const option = (name: string, fallback: number) => Number(process.argv.find(arg => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const baseBatches = option("base-batches", 40);
const port = option("port", 8790);

const directory = await mkdtemp(resolve(tmpdir(), "poneglyph-preview-"));
await build({ absWorkingDir: site, entryPoints: { playground: "src/index.ts", database: "../../packages/poneglyph-worker/src/index.ts", operator: "src/operator.ts" },
  outdir: directory, outExtension: { ".js": ".mjs" }, bundle: true, format: "esm", platform: "browser",
  target: "es2024", conditions: ["workerd", "worker", "browser"], external: ["cloudflare:*", "node:*"], logLevel: "warning" });

// Embed the built client into a tiny assets Worker (SPA fallback to index.html).
const assetsRoot = resolve(site, ".cloudflare/output/v0/workers/default/assets");
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const files: Record<string, { body: string; type: string }> = {};
async function walk(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = resolve(path, entry.name);
    if (entry.isDirectory()) await walk(full);
    else files[`/${relative(assetsRoot, full)}`] = { body: (await readFile(full)).toString("base64"), type: types[extname(full)] ?? "application/octet-stream" };
  }
}
await walk(assetsRoot);
const assetsScript = `const files = ${JSON.stringify(files)};
export default { fetch(request) { const path = new URL(request.url).pathname; const file = files[path] ?? files["/index.html"];
  return new Response(Uint8Array.from(atob(file.body), c => c.charCodeAt(0)), { headers: { "content-type": file.type } }); } };`;

const manifest = (contents: string) => ({ mainModule: "index.mjs", modules: { "index.mjs": { type: "esm" as const, contents } } });
const grants = { playground: { [GRAPH_ID]: ["read"] }, "playground-writer": { [GRAPH_ID]: ["read", "write"] }, "playground-loader": { [GRAPH_ID]: ["read", "write"] } };
const runtime = new Miniflare({ port, host: "127.0.0.1", resourcePersistencePath: resolve(directory, "state"), telemetry: { enabled: false }, log: new Log(LogLevel.WARN), workers: [
  { dev: { access: { aud: ACCESS_AUDIENCE, identity: { email: "preview@example.test" } } },
    config: { name: "playground", manifest: manifest(await readFile(resolve(directory, "playground.mjs"), "utf8")), compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: ["nodejs_compat"], env: {
      PONEGLYPH: { type: "worker", worker: "database", props: { clientId: "playground" } },
      PONEGLYPH_WRITER: { type: "worker", worker: "database", props: { clientId: "playground-writer" } },
      MCP_RATE_LIMITER: { type: "rate-limit", ...RATE_LIMIT }, API_RATE_LIMITER: { type: "rate-limit", ...API_RATE_LIMIT }, WRITE_RATE_LIMITER: { type: "rate-limit", ...WRITE_RATE_LIMIT },
      ASSETS: { type: "worker", worker: "assets" },
    } } },
  { config: { name: "assets", manifest: manifest(assetsScript), compatibilityDate: COMPATIBILITY_DATE } },
  { config: { name: "database", manifest: manifest(await readFile(resolve(directory, "database.mjs"), "utf8")), compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: ["nodejs_compat"], env: {
      GRAPH_FACADES: { type: "durable-object", worker: "database", exportName: "GraphCoordinatorDO" },
      GRAPH_LEDGERS: { type: "durable-object", worker: "database", exportName: "GraphLedgerDO" },
      GRAPH_TREES: { type: "durable-object", worker: "database", exportName: "GraphTreeDO" },
      GRAPH_SHARDS: { type: "durable-object", worker: "database", exportName: "GraphShardDO" },
      GRAPH_GRANTS: { type: "json", value: grants },
    }, exports: { GraphCoordinatorDO: { type: "durable-object", storage: "sqlite" }, GraphLedgerDO: { type: "durable-object", storage: "sqlite" }, GraphTreeDO: { type: "durable-object", storage: "sqlite" }, GraphShardDO: { type: "durable-object", storage: "sqlite" } } } },
  { config: { name: "operator", manifest: manifest(await readFile(resolve(directory, "operator.mjs"), "utf8")), compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: ["nodejs_compat"],
    env: { PONEGLYPH: { type: "worker", worker: "database", props: { clientId: "playground-loader" } } } } },
] });
await runtime.ready;
const operator = await runtime.getWorker("operator");
async function load(txId: string, facts: unknown[]): Promise<void> {
  const response = await operator.fetch("http://127.0.0.1/load", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txId, facts }) });
  if (!response.ok) throw new Error(`local load ${txId} failed: ${await response.text()}`);
  await response.text();
}
const overlay = (await readFile(resolve(site, "../../packages/write-path-bench/.data/onepiece-enrichment-v5-1446ff8fca4b/facts.ndjson"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as unknown);
for (let index = 0; index < overlay.length; index += 500) await load(`local:preview:overlay:${index}`, overlay.slice(index, index + 500));
const importDirectory = resolve(site, ".artifacts/import");
let loadedBase = 0;
for (const segment of ["pages10", "remainder90"] as const) {
  const plan = parseImportPlan(JSON.parse(await readFile(resolve(importDirectory, segment, "manifest.json"), "utf8")) as unknown);
  for (let index = 0; index < plan.batches.length && loadedBase < baseBatches; index++, loadedBase++) {
    const approved = await parseApprovedBatch(await readFile(resolve(importDirectory, segment, `${index}.json`)), plan);
    await load(approved.batch.txId, [...approved.batch.facts]);
  }
}
// The Luffy page lives deep in the corpus; add its base facts so the curated examples answer locally.
console.log(JSON.stringify({ event: "preview-ready", url: `http://127.0.0.1:${port}/`, overlayFacts: overlay.length, baseBatches: loadedBase, state: directory }));
process.on("SIGINT", () => { void runtime.dispose().then(() => process.exit(0)); });
