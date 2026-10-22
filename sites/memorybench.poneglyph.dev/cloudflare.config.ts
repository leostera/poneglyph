import { bindings, defineConfig } from "cf/config";
import { serviceWorker } from "@leostera/poneglyph-worker/config";
import * as site from "./src/index.ts" with { type: "cf-worker" };
import * as operator from "./src/operator.ts" with { type: "cf-worker" };
import { COMPATIBILITY_DATE, HOST } from "./src/registry.ts";

export const siteBindings = {
  PONEGLYPH: bindings.worker({ worker: serviceWorker, props: { clientId: "memorybench-reader" } }),
  // Empty until a dedicated Access app is created; denies every request.
  ACCESS_AUDIENCE: bindings.json<string>(""),
  MCP_RATE_LIMITER: bindings.rateLimit({ namespace: "2026102201", simple: { limit: 600, period: 60 } }),
};
export const operatorBindings = {
  PONEGLYPH: bindings.worker({ worker: serviceWorker, props: { clientId: "memorybench-loader" }, dev: { remote: true } }),
};
export default defineConfig(({ mode }) => {
  const local = mode === "operator";
  return { worker: {
    name: local ? "poneglyph-memorybench-local-operator" : "poneglyph-memorybench",
    entrypoint: local ? operator : site, compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: ["nodejs_compat"], workersDev: false, previewUrls: false,
    domains: local ? [] : [HOST],
    observability: { enabled: true, logs: { enabled: true }, traces: { enabled: true, headSamplingRate: 1 } },
    env: local ? operatorBindings : siteBindings,
  } };
});
