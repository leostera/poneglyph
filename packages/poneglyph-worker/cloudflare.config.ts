import { bindings, defineConfig, exports } from "cf/config";
import * as service from "./src/index.ts" with { type: "cf-worker" };
import type { GraphGrants } from "./src/authorization.js";

// Deployment-owned policy. The generic service/authorizer has no product names.
export const serviceWorker = {
  name: "poneglyph-service-worker",
  entrypoint: service,
  compatibilityDate: "2026-10-13",
  compatibilityFlags: ["nodejs_compat"],
  workersDev: false,
  previewUrls: false,
  domains: [],
  observability: { enabled: true, logs: { enabled: true }, traces: { enabled: true, headSamplingRate: 0.1 } },
  env: {
    GRAPH_COORDINATORS: bindings.durableObject({ worker: "poneglyph-service-worker", exportName: "GraphCoordinatorDO" }),
    GRAPH_SHARDS: bindings.durableObject({ worker: "poneglyph-service-worker", exportName: "GraphShardDO" }),
    GRAPH_GRANTS: bindings.json({
      playground: { onepiece: ["read"] },
      "playground-loader": { onepiece: ["read", "write"] },
    } satisfies GraphGrants),
  },
  exports: {
    GraphCoordinatorDO: exports.durableObject({ storage: "sqlite" }),
    GraphShardDO: exports.durableObject({ storage: "sqlite" }),
  },
};
export default defineConfig({ worker: serviceWorker });
