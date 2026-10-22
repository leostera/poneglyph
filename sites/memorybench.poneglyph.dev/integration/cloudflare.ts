// Copied into the pinned MemoryBench checkout by prepare-upstream.ts.
import { createOpenAI } from "@ai-sdk/openai";
import { readFileSync } from "node:fs";
export function createGatewayOpenAI(_unusedProviderKey: string) {
  const account = process.env.MEMORYBENCH_CF_ACCOUNT_ID;
  const tokenPath = process.env.MEMORYBENCH_CF_TOKEN_FILE;
  if (!account || !/^[a-f0-9]{32}$/.test(account) || !tokenPath) throw new Error("Configure personal Cloudflare account and token file for all model roles");
  return createOpenAI({
    apiKey: readFileSync(tokenPath, "utf8").trim(),
    baseURL: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`,
    headers: { "cf-aig-gateway-id": "default", "cf-aig-skip-cache": "true" },
  });
}
