import { createPublicPoneglyphMcpWorker } from "@leostera/poneglyph-mcp";
import type { InferEnv } from "cf/config";
import type { playgroundBindings } from "../cloudflare.config.ts";
import { connectionPage } from "./page.js";
import { DATASET, PUBLIC_HOST } from "./dataset.js";
import { admitMcpRequest } from "./rate-limit.js";
import { GRAPH_ID } from "./runtime.js";
import approvedPlan from "./import-plan.json";
import { parseImportPlan } from "./import-contract.js";
import { createImportHandler } from "./import.js";

type PlaygroundEnv = InferEnv<{ env: typeof playgroundBindings }>;
const readOnlyWorker = createPublicPoneglyphMcpWorker<PlaygroundEnv>({
  graphId: GRAPH_ID,
  service: env => env.PONEGLYPH,
  admit: (request, env) => admitMcpRequest(request, env.MCP_RATE_LIMITER),
  dataset: DATASET,
  serverInfo: { name: "poneglyph-onepiece-playground", version: "0.1.0" },
  allowedHostnames: [PUBLIC_HOST, "localhost", "127.0.0.1", "[::1]"],
  homepage: connectionPage,
});
const importBatch = createImportHandler(parseImportPlan(approvedPlan), PUBLIC_HOST);
export default {
  fetch(request: Request, env: PlaygroundEnv, ctx: ExecutionContext) {
    return new URL(request.url).pathname === "/import"
      ? importBatch(request, env, ctx)
      : readOnlyWorker.fetch(request, env);
  },
};
