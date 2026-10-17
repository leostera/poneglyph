import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare, Log, LogLevel, type MiniflareOptions } from "miniflare";
import { createDatabase, type GraphClient } from "@leostera/poneglyph";
import { parseApprovedBatch, parseImportPlan, type ImportPlan } from "../src/import-contract.js";

export type LocalGraph = Readonly<{ graph: GraphClient; close(): Promise<void> }>;
export type LocalPrefixLoad = Readonly<{ batches: number; pages: number; facts: number }>;

export async function openLocalGraph(graphId: string, runtimeDirectory: string): Promise<LocalGraph> {
  const packageDirectory = resolve(import.meta.dirname, "../../../packages/poneglyph");
  const bundlePath = resolve(packageDirectory, ".cloudflare/output/v0/workers/default/bundle/index.js");
  const bundle = await readFile(bundlePath, "utf8");
  const workerName = "poneglyph-rubric-local";
  const manifest = {mainModule: "index.js", modules: {"index.js": {type: "esm" as const, contents: bundle}}};
  const worker = (name: string) => ({type: "durable-object" as const, worker: workerName, exportName: name});
  const sqlite = {type: "durable-object" as const, storage: "sqlite" as const};
  // Instantiate Miniflare directly: Vite-based `cf dev` can ignore --persist-to,
  // which risks reusing the package's existing .cloudflare/state directory.
  const options: MiniflareOptions = {
    port: 0,
    host: "127.0.0.1",
    log: new Log(LogLevel.WARN),
    telemetry: {enabled: false},
    resourcePersistencePath: runtimeDirectory,
    workers: [{config: {
      name: workerName,
      manifest,
      compatibilityDate: "2026-10-06",
      env: {
        GRAPH_FACADES: worker("GraphCoordinatorDO"),
        GRAPH_LEDGERS: worker("GraphLedgerDO"),
        GRAPH_TREES: worker("GraphTreeDO"),
        GRAPH_SHARDS: worker("GraphShardDO"),
        TODO_HUBS: worker("TodoHubDO"),
      },
      exports: {
        GraphCoordinatorDO: sqlite,
        GraphLedgerDO: sqlite,
        GraphTreeDO: sqlite,
        GraphShardDO: sqlite,
        TodoHubDO: sqlite,
      },
    }}],
  };
  const miniflare = new Miniflare(options);
  try {
    const baseUrl = (await miniflare.ready).origin;
    const response = await fetch(`${baseUrl}/v1/graphs/${graphId}/entities?uri=${encodeURIComponent("wiki:onepiece:page:local-ready")}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`isolated local Worker readiness failed (HTTP ${response.status})`);
    await response.body?.cancel();
    const graph = createDatabase({url: baseUrl}).defineGraph({id: graphId});
    return Object.freeze({graph, close: () => miniflare.dispose()});
  } catch (error) {
    await miniflare.dispose();
    throw error;
  }
}

export async function replayReceiptPrefixLocally(
  graph: GraphClient,
  runId: string,
  prefix: Readonly<{pages: number; facts: number; lastRemainderOrdinal: number}>,
  onProgress: (loadedBatches: number, totalBatches: number, loadedFacts: number) => void,
): Promise<LocalPrefixLoad> {
  const site = resolve(import.meta.dirname, "..");
  const importDirectory = resolve(site, ".artifacts/import");
  const pagesPlan = parseImportPlan(JSON.parse(await readFile(resolve(importDirectory, "pages10/manifest.json"), "utf8")) as unknown);
  const remainderPlan = parseImportPlan(JSON.parse(await readFile(resolve(importDirectory, "remainder90/manifest.json"), "utf8")) as unknown);
  const lastRemainderOrdinal = prefix.lastRemainderOrdinal;
  if (!Number.isSafeInteger(lastRemainderOrdinal) || lastRemainderOrdinal < 0) throw new Error("query rubric has no bounded remainder ordinal");

  const batchesToLoad = pagesPlan.batches.length + lastRemainderOrdinal + 1;
  let loadedBatches = 0;
  let pages = 0;
  let facts = 0;
  for (const [segment, plan, lastOrdinal] of [
    ["pages10", pagesPlan, pagesPlan.batches.length - 1],
    ["remainder90", remainderPlan, lastRemainderOrdinal],
  ] as const) {
    for (let ordinal = 0; ordinal <= lastOrdinal; ordinal++) {
      const retry = plan.retry?.batch === ordinal ? plan.retry : undefined;
      const approved = retry ?? plan.batches[ordinal];
      if (!approved) throw new Error(`missing pinned ${segment} batch ${ordinal}`);
      const bodyName = retry === undefined ? `${ordinal}.json` : `${ordinal}-retry${retry.attempt}.json`;
      const bytes = await readFile(resolve(importDirectory, segment, bodyName));
      const parsed = await parseApprovedBatch(bytes, plan);
      if (parsed.ordinal !== ordinal || parsed.batch.facts.length !== approved.facts) {
        throw new Error(`pinned ${segment} payload ${ordinal} disagrees with its plan`);
      }

      // Replay the exact committed facts into a fresh local graph with a new
      // local identity. No hosted writer, import route, or retry is involved.
      const clientRequestToken = `local:query-rubric:${runId}:${segment}:${ordinal}`;
      const receipt = await graph.transact(parsed.batch.facts, {clientRequestToken});
      if (typeof receipt.txId !== "string") throw new Error(`local ${segment} batch ${ordinal} did not return a transaction witness`);
      loadedBatches++;
      pages += approved.pages;
      facts += approved.facts;
      if (loadedBatches % 100 === 0 || loadedBatches === batchesToLoad) {
        onProgress(loadedBatches, batchesToLoad, facts);
      }
    }
  }
  if (pages !== prefix.pages || facts !== prefix.facts) throw new Error("local receipt replay totals disagree with the pinned query prefix");
  return Object.freeze({batches: loadedBatches, pages, facts});
}
