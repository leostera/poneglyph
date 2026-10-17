import { bindings, defineConfig, exports } from "cf/config";
import * as service from "./src/index.ts" with { type: "cf-worker" };
import type { GraphGrants } from "./src/authorization.js";

// Deployment-owned policy. The generic service/authorizer has no product names.
function makeServiceWorker(name: string) {
  return {
    name,
    entrypoint: service,
    compatibilityDate: "2026-10-13",
    compatibilityFlags: ["nodejs_compat"],
    workersDev: false,
    previewUrls: false,
    domains: [],
    observability: { enabled: true, logs: { enabled: true }, traces: { enabled: true, headSamplingRate: 1.0 } },
    env: {
      GRAPH_FACADES: bindings.durableObject({ worker: name, exportName: "GraphCoordinatorDO" }),
      GRAPH_LEDGERS: bindings.durableObject({ worker: name, exportName: "GraphLedgerDO" }),
      GRAPH_TREES: bindings.durableObject({ worker: name, exportName: "GraphTreeDO" }),
      GRAPH_SHARDS: bindings.durableObject({ worker: name, exportName: "GraphShardDO" }),
      GRAPH_GRANTS: bindings.json({
        playground: { onepiece: ["read"] },
        "playground-loader": { onepiece: ["read", "write"] },
        "playground-importer": { onepiece: ["read", "write"] },
      } satisfies GraphGrants),
    },
    exports: {
      GraphCoordinatorDO: exports.durableObject({ storage: "sqlite" }),
      GraphLedgerDO: exports.durableObject({ storage: "sqlite" }),
      GraphTreeDO: exports.durableObject({ storage: "sqlite" }),
      GraphShardDO: exports.durableObject({ storage: "sqlite" }),
    },
  };
}

export const serviceWorker = makeServiceWorker("poneglyph-service-worker");
export default defineConfig({ worker: serviceWorker });
