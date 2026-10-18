import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const runBenchmark = process.env["PONEGLYPH_RUN_BENCH"] === "1";
const runTraffic = process.env["PONEGLYPH_RUN_TRAFFIC"] === "1";

export default defineConfig({
  define: {
    "import.meta.env.PONEGLYPH_RUN_BENCH": JSON.stringify(runBenchmark ? "1" : "0"),
  },
  plugins: [
    cloudflareTest({
      main: "./src/worker.ts",
      miniflare: {
        compatibilityDate: "2026-10-06",
        bindings: {
          TODO_SHARED_PASSPHRASE: "test-only-shared-passphrase",
          PONEGLYPH_RUN_BENCH: runBenchmark ? "1" : "0",
          PONEGLYPH_RUN_TRAFFIC: runTraffic ? "1" : "0",
        },
        durableObjects: {
          GRAPH_FACADES: { className: "GraphCoordinatorDO", useSQLite: true },
          GRAPH_LEDGERS: { className: "GraphLedgerDO", useSQLite: true },
          GRAPH_TREES: { className: "GraphTreeDO", useSQLite: true },
          GRAPH_SHARDS: { className: "GraphShardDO", useSQLite: true },
          TODO_HUBS: { className: "TodoHubDO", useSQLite: true },
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
