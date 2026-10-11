import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/worker.ts",
      miniflare: {
        compatibilityDate: "2026-10-06",
        durableObjects: {
          GRAPH_COORDINATORS: { className: "GraphCoordinatorDO", useSQLite: true },
          GRAPH_SHARDS: { className: "GraphShardDO", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    restoreMocks: true,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
