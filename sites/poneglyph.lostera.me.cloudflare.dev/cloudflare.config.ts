import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// A temporary production benchmark target for the write path, on Leo's
// individual work account. Every request needs the PONEGLYPH_TOKEN secret
// (`cf workers secrets update`); load generators reach the database through
// the Internal entrypoint, which only this Worker's own binding can call.
const NAME = "poneglyph-lostera-me-cloudflare-dev";

export default defineConfig({
  accountId: "776b37f0f2474156eb01cf93c764b2e9", // lostera-individual-account
  worker: {
    name: NAME,
    domains: ["poneglyph.lostera.me.cloudflare.dev"],
    workersDev: false,
    previewUrls: false,
    compatibilityDate: "2026-10-27",
    compatibilityFlags: ["nodejs_compat"],
    limits: { cpuMs: 300_000, subrequests: 100_000 },
    entrypoint,
    env: {
      GRAPH_FACADES: bindings.durableObject({ worker: NAME, exportName: "GraphCoordinatorDO" }),
      GRAPH_LEDGERS: bindings.durableObject({ worker: NAME, exportName: "GraphLedgerDO" }),
      GRAPH_TREES: bindings.durableObject({ worker: NAME, exportName: "GraphTreeDO" }),
      GRAPH_SHARDS: bindings.durableObject({ worker: NAME, exportName: "GraphShardDO" }),
      LOAD_GENERATOR: bindings.durableObject({ worker: NAME, exportName: "LoadGenerator" }),
      CEILING_PROBE: bindings.durableObject({ worker: NAME, exportName: "CeilingProbe" }),
      DATABASE: bindings.worker({ worker: NAME, exportName: "Internal" }),
    },
    exports: {
      GraphCoordinatorDO: exports.durableObject({ storage: "sqlite" }),
      GraphLedgerDO: exports.durableObject({ storage: "sqlite" }),
      GraphTreeDO: exports.durableObject({ storage: "sqlite" }),
      GraphShardDO: exports.durableObject({ storage: "sqlite" }),
      LoadGenerator: exports.durableObject({ storage: "sqlite" }),
      CeilingProbe: exports.durableObject({ storage: "sqlite" }),
      Internal: exports.worker(),
    },
    observability: { enabled: true, logs: { enabled: true, invocationLogs: true, headSamplingRate: 0.05 } },
  },
});
