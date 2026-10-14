import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/worker.ts" with { type: "cf-worker" };
import * as cleanupEntrypoint from "./src/cleanup-worker.ts" with { type: "cf-worker" };

const workerName = "poneglyph-scaleout-validation-20261011";
const compatibilityDate = "2026-10-06";

export default defineConfig(({ mode }) => {
  const cleanupMode = mode === "cleanup";

  return {
    worker: {
      name: workerName,
      compatibilityDate,
      entrypoint: cleanupMode ? cleanupEntrypoint : entrypoint,
      workersDev: false,
      observability: {
        enabled: true,
      },
      domains: cleanupMode ? [] : ["poneglyph-scaleout-20261011.poneglyph.leostera.dev"],
      env: cleanupMode
        ? {}
        : {
            GRAPH_COORDINATORS: bindings.durableObject({
              worker: workerName,
              exportName: "GraphCoordinatorDO",
            }),
            GRAPH_SHARDS: bindings.durableObject({
              worker: workerName,
              exportName: "GraphShardDO",
            }),
            TODO_HUBS: bindings.durableObject({
              worker: workerName,
              exportName: "TodoHubDO",
            }),
          },
      exports: cleanupMode
        ? {
            GraphCoordinatorDO: exports.durableObject({ state: "deleted" }),
            GraphShardDO: exports.durableObject({ state: "deleted" }),
            TodoHubDO: exports.durableObject({ state: "deleted" }),
          }
        : {
            GraphCoordinatorDO: exports.durableObject({ storage: "sqlite" }),
            GraphShardDO: exports.durableObject({ storage: "sqlite" }),
            TodoHubDO: exports.durableObject({ storage: "sqlite" }),
          },
    },
  };
});
