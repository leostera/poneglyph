import {bindings, defineConfig} from "cf/config";
import * as operator from "./operator.ts" with {type: "cf-worker"};
import {validationWorker} from "../cloudflare.config.ts";

// Fixed isolated target and principal. The caller can select only two fixed
// synthetic queries, never a graph, query text, writer method or binding props.
export const readBindings = {
  PONEGLYPH: bindings.worker({worker: validationWorker, props: {clientId: "playground-loader"}}),
  RUN_ID: bindings.json(process.env["PONEGLYPH_READ_BENCH_RUN_ID"] ?? "unbound"),
};
export default defineConfig(() => ({worker: {
  name: "poneglyph-validation-independent-read-operator", entrypoint: operator,
  compatibilityDate: "2026-10-13", compatibilityFlags: ["nodejs_compat"],
  workersDev: false, previewUrls: false, domains: [], env: readBindings,
}}));
