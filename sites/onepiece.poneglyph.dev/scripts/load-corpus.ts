// Bulk loader for the onepiece-wiki playground graph.
//
//   bun run dev:seed                     # terminal 1: loopback operator on 127.0.0.1:8878
//   bun run load:corpus -- plan          # verify every pinned payload offline; write the run manifest
//   bun run load:corpus -- run           # load (resumable); --concurrency=N (1..8, default 6)
//   bun run load:corpus -- status        # summarize the journal
//
// Safety rules (see RFD0006):
// - Every payload is verified against its pinned SHA-256 before it is sent.
// - Each batch has a stable transaction ID. An unknown outcome (timeout, 5xx,
//   disconnect) is reconciled by replaying the SAME ID and payload, which is
//   idempotent. A new ID (`:retry:N`) is minted only after storage durably
//   answers 422 (aborted: nothing applied).
// - Every attempt is journaled with fsync before dispatch and after the answer.
import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseApprovedBatch, parseImportPlan, type ImportPlan } from "../src/import-contract.js";
import { GRAPH_ID } from "../src/runtime.js";

const site = resolve(import.meta.dirname, "..");
const importDirectory = resolve(site, ".artifacts/import");
const runDirectory = resolve(importDirectory, GRAPH_ID);
const overlayDirectory = resolve(site, "../../packages/write-path-bench/.data/onepiece-enrichment-v5-1446ff8fca4b");
const OVERLAY_SHA256 = "916662b580009a734426436db0cffbc9e0e9b372155ee312cb08381f8bede359";
const OVERLAY_FACTS = 35_986;
const BASE_FACTS = 1_530_195;
const BATCH_FACTS = 500;
const ENDPOINT = "http://127.0.0.1:8878";
const MAX_UNKNOWN_REPLAYS = 8;
const MAX_ABORT_RETRIES = 3;

type Fact = Readonly<{ source: string; entity: string; field: string; value: unknown; retraction: boolean }>;
type Batch = Readonly<{ key: string; segment: "enrichment-v5" | "pages10" | "remainder90"; index: number; txId: string; sha256: string; facts: number; load(): Promise<readonly Fact[]> }>;
type Phase = "inflight" | "committed" | "unknown" | "aborted" | "rejected";
type JournalRecord = Readonly<{ at: string; key: string; txId: string; attempt: number; phase: Phase; [field: string]: unknown }>;

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const args = process.argv.slice(2);
const mode = args.find(arg => !arg.startsWith("--")) ?? "status";
const concurrencyArg = args.find(arg => arg.startsWith("--concurrency="))?.split("=")[1];
const concurrency = concurrencyArg === undefined ? 6 : Number(concurrencyArg);
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("--concurrency must be 1..8");

async function basePlan(segment: "pages10" | "remainder90"): Promise<{ plan: ImportPlan; planSha256: string }> {
  const bytes = await readFile(resolve(importDirectory, segment, "manifest.json"));
  return { plan: parseImportPlan(JSON.parse(bytes.toString("utf8")) as unknown), planSha256: sha256(bytes) };
}

function baseBatches(segment: "pages10" | "remainder90", plan: ImportPlan): Batch[] {
  return plan.batches.map((batch, index) => ({
    key: `${segment}:${index}`, segment, index, txId: batch.txId, sha256: batch.sha256, facts: batch.facts,
    async load() {
      const bytes = await readFile(resolve(importDirectory, segment, `${index}.json`));
      const approved = await parseApprovedBatch(bytes, plan);
      if (approved.ordinal !== index || approved.batch.txId !== batch.txId) throw new Error(`pinned ${segment}:${index} payload identity changed`);
      return approved.batch.facts.map(fact => ({ ...fact, retraction: fact.retraction ?? false })) as readonly Fact[];
    },
  }));
}

// Deterministic overlay batching: whole entities, file order, ≤500 facts.
async function overlayBatches(): Promise<{ batches: Batch[]; planSha256: string }> {
  const bytes = await readFile(resolve(overlayDirectory, "facts.ndjson"));
  if (sha256(bytes) !== OVERLAY_SHA256) throw new Error("overlay facts.ndjson does not match the pinned SHA-256");
  const facts = bytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Fact);
  if (facts.length !== OVERLAY_FACTS) throw new Error("overlay fact count changed");
  const byEntity = new Map<string, Fact[]>();
  for (const fact of facts) {
    if (fact.retraction !== false || !fact.source.startsWith("wiki:onepiece:derived:")) throw new Error("overlay contains an unexpected fact");
    const group = byEntity.get(fact.entity) ?? [];
    group.push(fact);
    byEntity.set(fact.entity, group);
  }
  const groups: Fact[][] = [];
  let current: Fact[] = [];
  for (const group of byEntity.values()) {
    if (group.length > BATCH_FACTS) throw new Error("one overlay entity exceeds a batch");
    if (current.length + group.length > BATCH_FACTS) { groups.push(current); current = []; }
    current.push(...group);
  }
  if (current.length) groups.push(current);
  const planned = groups.map((group, index) => ({ txId: `wiki:import:${OVERLAY_SHA256}:enrichment-v5:${index}`, sha256: sha256(JSON.stringify(group)), facts: group.length, group }));
  const planSha256 = sha256(JSON.stringify(planned.map(({ group: _group, ...batch }) => batch)));
  return {
    planSha256,
    batches: planned.map(({ group, ...batch }, index) => ({
      key: `enrichment-v5:${index}`, segment: "enrichment-v5", index, ...batch,
      async load() { if (sha256(JSON.stringify(group)) !== batch.sha256) throw new Error("overlay batch changed in memory"); return group; },
    })),
  };
}

async function allBatches() {
  const pages10 = await basePlan("pages10");
  const remainder90 = await basePlan("remainder90");
  if (pages10.plan.corpusSha256 !== remainder90.plan.corpusSha256 || pages10.plan.selectedFacts + remainder90.plan.selectedFacts !== BASE_FACTS) {
    throw new Error("base plans do not describe the complete pinned corpus");
  }
  const overlay = await overlayBatches();
  // Overlay first: it is small and powers the curated demo queries.
  const batches = [...overlay.batches, ...baseBatches("pages10", pages10.plan), ...baseBatches("remainder90", remainder90.plan)];
  return { batches, sources: {
    corpusSha256: pages10.plan.corpusSha256, xmlSha256: pages10.plan.xmlSha256,
    plans: { pages10: pages10.planSha256, remainder90: remainder90.planSha256, "enrichment-v5": overlay.planSha256 },
    overlaySha256: OVERLAY_SHA256,
  } };
}

const manifestPath = resolve(runDirectory, "manifest.json");
const journalPath = resolve(runDirectory, "journal.ndjson");

type BatchState = { committed: boolean; attempt: number; lastTxId?: string; unresolved: boolean; aborts: number; commitSeq?: number };
async function readJournal(): Promise<Map<string, BatchState>> {
  const text = await readFile(journalPath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
  const state = new Map<string, BatchState>();
  for (const line of text.split("\n").filter(Boolean)) {
    const record = JSON.parse(line) as JournalRecord;
    const entry = state.get(record.key) ?? { committed: false, attempt: 0, unresolved: false, aborts: 0 };
    if (entry.committed) throw new Error(`journal records activity after ${record.key} committed`);
    entry.attempt = record.attempt;
    entry.lastTxId = record.txId;
    if (record.phase === "inflight" || record.phase === "unknown") entry.unresolved = true;
    if (record.phase === "committed") { entry.committed = true; entry.unresolved = false; entry.commitSeq = record["commitSeq"] as number; }
    if (record.phase === "aborted") { entry.unresolved = false; entry.aborts++; }
    if (record.phase === "rejected") entry.unresolved = false;
    state.set(record.key, entry);
  }
  return state;
}

let journalChain: Promise<void> = Promise.resolve();
let journalHandle: Awaited<ReturnType<typeof open>> | undefined;
function journal(record: Omit<JournalRecord, "at">): Promise<void> {
  journalChain = journalChain.then(async () => {
    journalHandle ??= await open(journalPath, "a");
    await journalHandle.write(JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
    await journalHandle.sync();
  });
  return journalChain;
}

type LoadAnswer = { kind: "committed"; commitSeq: number } | { kind: "aborted"; status: number } | { kind: "rejected"; status: number; message?: string } | { kind: "unknown"; status?: number; message?: string };
async function send(txId: string, facts: readonly Fact[]): Promise<LoadAnswer> {
  let response: Response;
  try {
    response = await fetch(`${ENDPOINT}/load`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txId, facts }), signal: AbortSignal.timeout(120_000) });
  } catch (error) { return { kind: "unknown", message: error instanceof Error ? error.name : "fetch failed" }; }
  const body = await response.json().catch(() => undefined) as { txId?: string; status?: string; commitSeq?: number; delivery?: string; error?: { status?: number; message?: string } } | undefined;
  if (response.ok && body?.txId === txId && body.status === "committed" && Number.isSafeInteger(body.commitSeq) && body.commitSeq! > 0) return { kind: "committed", commitSeq: body.commitSeq! };
  const status = body?.error?.status;
  if (body?.delivery === "rejected" && status === 422) return { kind: "aborted", status };
  if (body?.delivery === "rejected" && status !== undefined) return { kind: "rejected", status, message: body.error?.message };
  return { kind: "unknown", status: status ?? response.status, message: body?.error?.message };
}

class Stop extends Error {}
async function loadBatch(batch: Batch, entry: BatchState): Promise<number> {
  const facts = await batch.load();
  if (facts.length !== batch.facts) throw new Stop(`${batch.key}: payload has ${facts.length} facts, plan says ${batch.facts}`);
  let attempt = entry.attempt;
  let txId = entry.unresolved && entry.lastTxId ? entry.lastTxId : entry.aborts === 0 ? batch.txId : `${batch.txId}:retry:${entry.aborts}`;
  let aborts = entry.aborts;
  let replays = 0;
  for (;;) {
    attempt++;
    await journal({ key: batch.key, txId, attempt, phase: "inflight", facts: batch.facts, sha256: batch.sha256 });
    const started = performance.now();
    const answer = await send(txId, facts);
    const elapsedMs = Math.round(performance.now() - started);
    if (answer.kind === "committed") {
      await journal({ key: batch.key, txId, attempt, phase: "committed", commitSeq: answer.commitSeq, elapsedMs });
      return elapsedMs;
    }
    if (answer.kind === "aborted") {
      aborts++;
      await journal({ key: batch.key, txId, attempt, phase: "aborted", status: answer.status, elapsedMs });
      if (aborts > MAX_ABORT_RETRIES) throw new Stop(`${batch.key}: aborted ${aborts} times; stopping for review`);
      txId = `${batch.txId}:retry:${aborts}`;
      replays = 0;
      continue;
    }
    if (answer.kind === "rejected") {
      await journal({ key: batch.key, txId, attempt, phase: "rejected", status: answer.status, message: answer.message, elapsedMs });
      throw new Stop(`${batch.key}: rejected with HTTP ${answer.status}: ${answer.message ?? ""}`);
    }
    await journal({ key: batch.key, txId, attempt, phase: "unknown", status: answer.status, message: answer.message, elapsedMs });
    replays++;
    if (replays > MAX_UNKNOWN_REPLAYS) throw new Stop(`${batch.key}: outcome still unknown after ${MAX_UNKNOWN_REPLAYS} same-ID replays; resume later to keep reconciling ${txId}`);
    await sleep(Math.min(30_000, 1_000 * 2 ** replays));
  }
}

async function run(): Promise<void> {
  const { batches, sources } = await allBatches();
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { sources: unknown; batches: number; facts: number };
  if (JSON.stringify(manifest.sources) !== JSON.stringify(sources) || manifest.batches !== batches.length) throw new Error("run manifest does not match the pinned sources; run `plan` again in a new directory");
  const probe = await fetch(`${ENDPOINT}/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: 'wiki:page:title(Page, "Monkey D. Luffy")' }), signal: AbortSignal.timeout(60_000) });
  if (!probe.ok) throw new Error(`operator readiness query failed with HTTP ${probe.status}`);
  await probe.body?.cancel();
  const state = await readJournal();
  const todo = batches.filter(batch => !state.get(batch.key)?.committed);
  const totalFacts = batches.reduce((sum, batch) => sum + batch.facts, 0);
  let committedFacts = batches.filter(batch => state.get(batch.key)?.committed).reduce((sum, batch) => sum + batch.facts, 0);
  console.log(JSON.stringify({ event: "start", graphId: GRAPH_ID, pendingBatches: todo.length, totalBatches: batches.length, committedFacts, totalFacts, concurrency }));
  const started = Date.now();
  let cursor = 0, completed = 0, stop: Error | undefined;
  const timings: number[] = [];
  const worker = async () => {
    while (!stop) {
      const batch = todo[cursor++];
      if (!batch) return;
      try {
        timings.push(await loadBatch(batch, state.get(batch.key) ?? { committed: false, attempt: 0, unresolved: false, aborts: 0 }));
        completed++; committedFacts += batch.facts;
        if (completed % 25 === 0 || completed === todo.length) {
          const rate = completed / ((Date.now() - started) / 1000);
          const sorted = timings.toSorted((a, b) => a - b);
          console.log(JSON.stringify({ event: "progress", completed, pending: todo.length - completed, committedFacts, totalFacts,
            batchesPerSecond: Math.round(rate * 100) / 100, etaMinutes: Math.round((todo.length - completed) / rate / 60),
            batchMs: { p50: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)] } }));
        }
      } catch (error) { stop = error instanceof Error ? error : new Error(String(error)); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  await journalChain;
  await journalHandle?.close();
  if (stop) throw stop;
  console.log(JSON.stringify({ event: "complete", graphId: GRAPH_ID, batches: batches.length, committedFacts, totalFacts, minutes: Math.round((Date.now() - started) / 60_000) }));
}

async function plan(): Promise<void> {
  const { batches, sources } = await allBatches();
  // Verify every payload before any write is possible.
  let facts = 0;
  for (const batch of batches) facts += (await batch.load()).length;
  if (facts !== BASE_FACTS + OVERLAY_FACTS) throw new Error(`verified ${facts} facts; expected ${BASE_FACTS + OVERLAY_FACTS}`);
  await mkdir(runDirectory, { recursive: true });
  const manifest = { version: 1, graphId: GRAPH_ID, service: "poneglyph-service-worker", principal: "playground-loader", createdAt: new Date().toISOString(),
    authorization: "Owner requested loading all One Piece graph data into the deployed playground (2026-10-21).",
    sources, batches: batches.length, facts,
    segments: Object.fromEntries(["enrichment-v5", "pages10", "remainder90"].map(segment => [segment, {
      batches: batches.filter(batch => batch.segment === segment).length, facts: batches.filter(batch => batch.segment === segment).reduce((sum, batch) => sum + batch.facts, 0) }])),
    rules: { unknownOutcome: "replay the same txId and payload", aborted422: "mint txId:retry:N, at most 3", rejected4xx: "stop" } };
  try { await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", flush: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = JSON.parse(await readFile(manifestPath, "utf8")) as { sources: unknown };
    if (JSON.stringify(existing.sources) !== JSON.stringify(sources)) throw new Error("existing run manifest has different sources");
  }
  console.log(JSON.stringify({ event: "planned", manifestPath, batches: batches.length, facts, segments: manifest.segments }));
}

async function status(): Promise<void> {
  const { batches } = await allBatches();
  const state = await readJournal();
  const committed = batches.filter(batch => state.get(batch.key)?.committed);
  const unresolved = [...state.entries()].filter(([, entry]) => entry.unresolved).map(([key, entry]) => ({ key, txId: entry.lastTxId }));
  const retried = [...state.entries()].filter(([, entry]) => entry.aborts > 0).map(([key, entry]) => ({ key, aborts: entry.aborts, committed: entry.committed }));
  console.log(JSON.stringify({ graphId: GRAPH_ID, committedBatches: committed.length, totalBatches: batches.length,
    committedFacts: committed.reduce((sum, batch) => sum + batch.facts, 0), totalFacts: batches.reduce((sum, batch) => sum + batch.facts, 0),
    maxCommitSeq: Math.max(0, ...[...state.values()].map(entry => entry.commitSeq ?? 0)), unresolved, retriedAfterAbort: retried }, null, 2));
}

if (mode === "plan") await plan();
else if (mode === "run") await run();
else if (mode === "status") await status();
else throw new Error("Use plan, run or status");
