import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseFactBatch, type FactInput } from "@leostera/poneglyph";
import { ROOT } from "./build.js";
import { SCENARIOS, integerOption } from "./scenarios.js";
const limit = integerOption(process.env.BENCH_FACTS, 1_000_000, 2_000_000);

// Bounded full-stream feasibility check, not a substitute for writes or a performance run.
const scenarios = SCENARIOS.map(scenario => ({ ...scenario, pending: [] as FactInput[], transactions: 0,
  maxEntitiesPerBatch: 0, maxPayloadBytes: 0, invalidBatches: 0, batchesAboveKnownSqlBindLimit: 0, firstError: undefined as string | undefined }));
let facts = 0;
function flush(state: typeof scenarios[number]) {
  if (!state.pending.length) return;
  const parsed = parseFactBatch({ txId: `bench:preflight:${state.name}:${state.transactions}`, facts: state.pending });
  const entities = new Set(state.pending.map(fact => fact.entity)).size;
  state.maxEntitiesPerBatch = Math.max(state.maxEntitiesPerBatch, entities);
  if (entities > 100) state.batchesAboveKnownSqlBindLimit++;
  if (!parsed.ok) { state.invalidBatches++; state.firstError ??= parsed.error.message; }
  else {
    const bytes = Buffer.byteLength(JSON.stringify(parsed.value));
    state.maxPayloadBytes = Math.max(state.maxPayloadBytes, bytes);
    if (bytes > 1_000_000) { state.invalidBatches++; state.firstError ??= "canonical request exceeds 1 MB"; }
  }
  state.transactions++; state.pending = [];
}
const lines = createInterface({ input: createReadStream(resolve(ROOT, ".data/facts.ndjson")), crlfDelay: Infinity });
for await (const line of lines) {
  const raw: unknown = JSON.parse(line);
  const parsed = parseFactBatch({ txId: "bench:preflight:fact", facts: [raw] });
  if (!parsed.ok) throw new Error(`invalid fact ${facts}: ${parsed.error.message}`);
  const fact = parsed.value.facts[0]!; facts++;
  for (const state of scenarios) {
    state.pending.push(fact);
    if (state.pending.length === state.batchSize) flush(state);
  }
  if (facts === limit) break;
}
if (facts !== limit) throw new Error(`only ${facts} facts available, requested ${limit}`);
for (const state of scenarios) flush(state);
const result = { kind: "selected corpus-prefix feasibility only; no database writes or throughput measurements; does not gate or adapt workload delivery", facts,
  corpus: JSON.parse(await readFile(resolve(ROOT, ".data/manifest.json"), "utf8")),
  baselineOutcomeRetentionLimit: 100000,
  scenarios: scenarios.map(({ pending, ...state }) => ({ ...state, exceedsRetainedOutcomeLimit: state.transactions > 100000 })) };
await mkdir(resolve(ROOT, "results"), { recursive: true });
await writeFile(resolve(ROOT, `results/${facts}-fact-preflight.json`), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
