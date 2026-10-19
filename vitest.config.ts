import {resolve} from "node:path";
import {defineConfig} from "vitest/config";

const root = import.meta.dirname;

export default defineConfig({
  test: {
    projects: [
      {
        extends: "./packages/poneglyph/vitest.config.ts",
        test: {
          name: "worker",
          root: resolve(root, "packages/poneglyph"),
          include: ["tests/**/*.test.ts"],
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
      {
        test: {
          name: "node",
          root,
          environment: "node",
          include: [
            "tests/conformance/**/*.test.ts",
            "packages/poneglyph-mcp/test/**/*.test.ts",
            "packages/poneglyph-worker/test/**/*.test.ts",
            "packages/write-path-bench/tests/**/*.test.ts",
            "examples/*/test/**/*.test.ts",
            "sites/*/test/**/*.test.ts",
          ],
          restoreMocks: true,
          testTimeout: 20_000,
          hookTimeout: 20_000,
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
    ],
  },
});
