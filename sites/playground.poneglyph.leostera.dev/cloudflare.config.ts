import { bindings, defineConfig, exports } from "cf/config";
import * as playground from "./src/index.ts" with { type: "cf-worker" };
import * as database from "./src/database.ts" with { type: "cf-worker" };
import { RATE_LIMIT } from "./src/rate-limit.ts";
import { COMPATIBILITY_DATE } from "./src/runtime.ts";

const databaseName = "poneglyph-onepiece-playground-db";
const databaseBindings = {
  GRAPH_COORDINATORS: bindings.durableObject({ worker: databaseName, exportName: "GraphCoordinatorDO" }),
  GRAPH_SHARDS: bindings.durableObject({ worker: databaseName, exportName: "GraphShardDO" }),
};
export const playgroundBindings = {
  PONEGLYPH: bindings.worker({ worker: databaseName }),
  MCP_RATE_LIMITER: bindings.rateLimit(RATE_LIMIT),
};
const databaseExports = {
  GraphCoordinatorDO: exports.durableObject({ storage: "sqlite" }),
  GraphShardDO: exports.durableObject({ storage: "sqlite" }),
};

export default defineConfig(({ mode }) => {
  const databaseMode = mode === "database";
  return {
    worker: {
      name: databaseMode ? databaseName : "playground-poneglyph-leostera-dev",
      compatibilityDate: COMPATIBILITY_DATE,
      compatibilityFlags: ["nodejs_compat"],
      entrypoint: databaseMode ? database : playground,
      workersDev: false,
      previewUrls: false,
      domains: databaseMode ? [] : ["playground.poneglyph.leostera.dev"],
      observability: { enabled: true, logs: { enabled: true }, traces: { enabled: true, headSamplingRate: 0.1 } },
      env: databaseMode ? databaseBindings : playgroundBindings,
      exports: databaseMode ? databaseExports : {},
    },
  };
});
