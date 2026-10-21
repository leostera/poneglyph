import { bindings, defineConfig } from "cf/config";
import * as playground from "./src/index.ts" with { type: "cf-worker" };
import * as operator from "./src/operator.ts" with { type: "cf-worker" };
import { serviceWorker } from "@leostera/poneglyph-worker/config";
import { API_RATE_LIMIT, WRITE_RATE_LIMIT } from "./src/api.ts";
import { RATE_LIMIT } from "./src/rate-limit.ts";

// Principals are deployment-owned props. The service grants "playground"
// read-only and "playground-writer" read/write on the one playground graph.
export const playgroundBindings = {
  PONEGLYPH: bindings.worker({ worker: serviceWorker, props: { clientId: "playground" } }),
  PONEGLYPH_WRITER: bindings.worker({ worker: serviceWorker, props: { clientId: "playground-writer" } }),
  MCP_RATE_LIMITER: bindings.rateLimit(RATE_LIMIT),
  API_RATE_LIMITER: bindings.rateLimit(API_RATE_LIMIT),
  WRITE_RATE_LIMITER: bindings.rateLimit(WRITE_RATE_LIMIT),
  ASSETS: bindings.assets(),
};
// Loopback-only bulk loader (`cf dev --mode seed`); never deployed.
export const seedBindings = {
  PONEGLYPH: bindings.worker({ worker: serviceWorker, props: { clientId: "playground-loader" }, dev: { remote: true } }),
};
export default defineConfig(({ mode }) => {
  const seedMode = mode === "seed";
  return {
    worker: {
      name: seedMode ? "poneglyph-playground-local-operator" : "playground-poneglyph-leostera-dev",
      entrypoint: seedMode ? operator : playground,
      compatibilityDate: "2026-10-13",
      compatibilityFlags: ["nodejs_compat"],
      workersDev: false,
      previewUrls: false,
      domains: seedMode ? [] : ["onepiece.poneglyph.dev"],
      ...(seedMode ? {} : { assets: { runWorkerFirst: true, notFoundHandling: "single-page-application" as const } }),
      observability: { enabled: true, logs: { enabled: true }, traces: { enabled: true, headSamplingRate: 1.0 } },
      env: seedMode ? seedBindings : playgroundBindings,
    }
  };
});
