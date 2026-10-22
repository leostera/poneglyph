import { bindings, defineConfig, exports } from "cf/config";
import * as service from "./src/index.ts" with { type: "cf-worker" };
import type { GraphPermission } from "./src/authorization.js";
import { memorybenchGrants } from "./memorybench-grants.ts";
import { splitGrantBindings } from "./src/grant-bindings.ts";

// Deployment-owned policy. The generic service/authorizer has no product names.
type GrantJson = Record<string, Record<string, GraphPermission[]>>;

// The One Piece playground reads (MCP + browser), appends attributed browser
// facts, and bulk-loads the pinned corpus, each through a distinct principal.
const serviceGrants: GrantJson = {
  ...memorybenchGrants,
  playground: { "onepiece-wiki": ["read"] },
  "playground-writer": { "onepiece-wiki": ["read", "write"] },
  "playground-loader": { "onepiece-wiki": ["read", "write"] },
};

const validationGrants: GrantJson = {
  ...serviceGrants,
  "playground-loader": {
    "onepiece-wiki": ["read", "write"],
    onepiece: ["read", "write"],
    "control-plane-validation": ["read", "write"],
  },
};

function makeServiceWorker(name: string, grants: GrantJson) {
  const { GRAPH_GRANTS, ...extraGrants } = splitGrantBindings(grants);
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
      GRAPH_GRANTS: bindings.json(GRAPH_GRANTS),
      ...Object.fromEntries(Object.entries(extraGrants).map(([key, value]) => [key, bindings.json(value)])),
    },
    exports: {
      GraphCoordinatorDO: exports.durableObject({ storage: "sqlite" }),
      GraphLedgerDO: exports.durableObject({ storage: "sqlite" }),
      GraphTreeDO: exports.durableObject({ storage: "sqlite" }),
      GraphShardDO: exports.durableObject({ storage: "sqlite" }),
    },
  };
}

export const serviceWorker = makeServiceWorker("poneglyph-service-worker", serviceGrants);
export const validationWorker = makeServiceWorker("poneglyph-mavplus-validation-worker", validationGrants);
export default defineConfig(({ mode }) => ({
  worker: mode === "mavplus-validation" ? validationWorker : serviceWorker,
}));
