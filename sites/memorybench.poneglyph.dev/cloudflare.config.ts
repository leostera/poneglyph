import { bindings, defineConfig } from "cf/config";
import { serviceWorker } from "@leostera/poneglyph-worker/config";
import * as site from "./src/index.ts" with { type: "cf-worker" };
import * as operator from "./src/operator.ts" with { type: "cf-worker" };

export const siteBindings = {
  PONEGLYPH: bindings.worker({ worker: serviceWorker, props: { clientId: "memorybench-reader" } }),
  // Dedicated Worker-scoped Access app; runtime still fails closed if detached.
  ACCESS_AUDIENCE: bindings.json<string>("2a1820cd36392d673415ff39ed8d1f5bb187e8e5135c351d1117904c21c1f77a"),
  MCP_RATE_LIMITER: bindings.rateLimit({ namespace: "2026102201", simple: { limit: 600, period: 60 } }),
};
export const operatorBindings = {
  PONEGLYPH: bindings.worker({ worker: serviceWorker, props: { clientId: "memorybench-loader" }, dev: { remote: true } }),
};
export default defineConfig(({ mode }) => {
  const local = mode === "operator";
  return { worker: {
    name: local ? "poneglyph-memorybench-local-operator" : "poneglyph-memorybench",
    entrypoint: local ? operator : site, compatibilityDate: "2026-10-13",
    compatibilityFlags: ["nodejs_compat"], workersDev: false, previewUrls: false,
    domains: local ? [] : ["memorybench.poneglyph.dev"],
    observability: { enabled: true, logs: { enabled: true }, traces: { enabled: true, headSamplingRate: 1 } },
    env: local ? operatorBindings : siteBindings,
  } };
});
