// Local, offline preview of the browser playground against real canonical
// SQLite actors. Embeds the built client (run `bun run build:client` first) and loads the v5 overlay plus a slice of pinned base
// batches into a temporary graph. No Cloudflare credentials or network.
//
//   bun run preview:local [-- --base-batches=40 --port=8790]
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { build } from "esbuild";
import { clientAssetsModule } from "../build/client-assets.js";
import { Log, LogLevel, Miniflare } from "miniflare";
import { API_RATE_LIMIT, WRITE_RATE_LIMIT } from "../src/api.js";
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
  target: "es2024", conditions: ["workerd", "worker", "browser"], external: ["cloudflare:*", "node:*"], logLevel: "warning",
  plugins: [{ name: "embed-client", setup(builder) {
    builder.onResolve({ filter: /^virtual:playground-client$/ }, () => ({ path: "client", namespace: "embed-client" }));
    builder.onLoad({ filter: /.*/, namespace: "embed-client" }, async () => ({ loader: "js", contents: await clientAssetsModule() }));
  } }] });

const manifest = (contents: string) => ({ mainModule: "index.mjs", modules: { "index.mjs": { type: "esm" as const, contents } } });
const grants = { playground: { [GRAPH_ID]: ["read"] }, "playground-writer": { [GRAPH_ID]: ["read", "write"] }, "playground-loader": { [GRAPH_ID]: ["read", "write"] } };
const runtime = new Miniflare({ port, host: "127.0.0.1", resourcePersistencePath: resolve(directory, "state"), telemetry: { enabled: false }, log: new Log(LogLevel.WARN), workers: [
  { config: { name: "playground", manifest: manifest(await readFile(resolve(directory, "playground.mjs"), "utf8")), compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: ["nodejs_compat"], env: {
      PONEGLYPH: { type: "worker", worker: "database", props: { clientId: "playground" } },
      PONEGLYPH_WRITER: { type: "worker", worker: "database", props: { clientId: "playground-writer" } },
      MCP_RATE_LIMITER: { type: "rate-limit", ...RATE_LIMIT }, API_RATE_LIMITER: { type: "rate-limit", ...API_RATE_LIMIT }, WRITE_RATE_LIMITER: { type: "rate-limit", ...WRITE_RATE_LIMIT },
    } } },
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
console.log(JSON.stringify({ event: "preview-ready", url: `http://127.0.0.1:${port}/`, overlayFacts: overlay.length, baseBatches: loadedBase, state: directory }));
process.on("SIGINT", () => { void runtime.dispose().then(() => process.exit(0)); });
