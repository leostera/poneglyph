import {bindings, defineConfig} from "cf/config";
import * as operator from "./operator.ts" with {type: "cf-worker"};

// Existing isolated namespaces only. No deployment, class migration or public target.
const worker = "poneglyph-mavplus-validation-worker";
export const writeBindings = {
  GRAPH_FACADES: bindings.durableObject({worker, exportName: "GraphCoordinatorDO"}),
  GRAPH_LEDGERS: bindings.durableObject({worker, exportName: "GraphLedgerDO"}),
  RUN_ID: bindings.json(process.env["PONEGLYPH_WRITE_BENCH_RUN_ID"] ?? "unbound"),
  CASE: bindings.json(process.env["PONEGLYPH_WRITE_BENCH_CASE"] ?? "unbound"),
  COUNT: bindings.json(Number(process.env["PONEGLYPH_WRITE_BENCH_COUNT"] ?? "0")),
  AUDIT_ONLY: bindings.json(process.env["PONEGLYPH_WRITE_BENCH_AUDIT_ONLY"] === "1"),
};
export default defineConfig(() => ({worker: {
  name: "poneglyph-validation-independent-write-operator", entrypoint: operator,
  compatibilityDate: "2026-10-18", compatibilityFlags: ["nodejs_compat"],
  workersDev: false, previewUrls: false, domains: [], env: writeBindings,
}}));
