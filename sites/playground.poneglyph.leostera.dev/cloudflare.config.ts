import { bindings, defineConfig } from "cf/config";
import * as playground from "./src/index.ts" with { type: "cf-worker" };
import * as operator from "./src/operator.ts" with { type: "cf-worker" };
import { serviceWorker } from "@leostera/poneglyph-worker/config";

export const playgroundBindings = {
  PONEGLYPH: bindings.worker({ worker: serviceWorker, props: { clientId: "playground" } }),
  MCP_RATE_LIMITER: bindings.rateLimit({ namespace: "2026101401", simple: { limit: 30, period: 60 } }),
  PONEGLYPH_IMPORT: bindings.worker({ worker: serviceWorker, props: { clientId: "playground-importer" } }),
  IMPORT_RATE_LIMITER: bindings.rateLimit({ namespace: "2026101403", simple: { limit: 60, period: 60 } }),
};
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
      observability: { enabled: true, logs: { enabled: true }, traces: { enabled: true, headSamplingRate: 0.1 } },
      env: seedMode ? seedBindings : playgroundBindings,
    }
  };
});
