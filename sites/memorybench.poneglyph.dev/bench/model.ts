import { readFile } from "node:fs/promises";
import { Store, record } from "./store.js";
export const MODEL = "@cf/openai/gpt-oss-120b";
export type ChatMessage = Record<string, unknown>;
export interface ToolCall { id: string; name: string; arguments: string }
export interface ModelAnswer { content: string; calls: ToolCall[]; raw: Record<string, unknown> }
export interface ModelClient { complete(role: string, messages: ChatMessage[], tools?: unknown[]): Promise<ModelAnswer> }
export class GatewayModel implements ModelClient {
  constructor(private readonly store: Store) {}
  async complete(role: string, messages: ChatMessage[], tools?: unknown[]): Promise<ModelAnswer> {
    const account = process.env.MEMORYBENCH_CF_ACCOUNT_ID;
    const tokenPath = process.env.MEMORYBENCH_CF_TOKEN_FILE;
    if (!account || !/^[a-f0-9]{32}$/.test(account) || !tokenPath) throw new Error("Configure personal Cloudflare account and token file");
    const token = (await readFile(tokenPath, "utf8")).trim();
    const started = performance.now();
    const request = { model: MODEL, messages, reasoning_effort: "low", max_completion_tokens: 8192, ...(tools ? { tools, tool_choice: "auto" } : {}) };
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "cf-aig-gateway-id": "default", "cf-aig-skip-cache": "true" },
      body: JSON.stringify(request), signal: AbortSignal.timeout(180_000),
    });
    const raw: unknown = await response.json();
    await this.store.event({ phase: "model", role, model: MODEL, elapsedMs: Math.round(performance.now() - started), status: response.status, gatewayRequestId: response.headers.get("cf-aig-log-id"), usage: typeof raw === "object" && raw !== null && "usage" in raw ? raw.usage : undefined });
    if (!response.ok) throw new Error(`Cloudflare model call failed: HTTP ${response.status}`);
    const parsed = record(raw);
    if (!Array.isArray(parsed.choices) || parsed.choices.length !== 1) throw new Error("Expected one model choice");
    const choice = record(parsed.choices[0]);
    if (choice.finish_reason === "length") throw new Error("Model output exhausted its token budget");
    const message = record(choice.message);
    const calls: ToolCall[] = [];
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls)) throw new Error("Invalid tool calls");
      for (const item of message.tool_calls) {
        const call = record(item), fn = record(call.function);
        if (typeof call.id !== "string" || typeof fn.name !== "string" || typeof fn.arguments !== "string") throw new Error("Invalid tool call shape");
        calls.push({ id: call.id, name: fn.name, arguments: fn.arguments });
      }
    }
    if (message.content !== null && message.content !== undefined && typeof message.content !== "string") throw new Error("Invalid model content");
    const content = typeof message.content === "string" ? message.content : "";
    if (!content && !calls.length) throw new Error("Model returned neither text nor tools");
    return { content, calls, raw: message };
  }
}
