import {parseFactBatch} from "@leostera/poneglyph";
import {isRecord, factAsJson} from "@leostera/poneglyph/storage-protocol";

export type WriteCase = "hot" | "graph";
export const phases = ["planning", "reserving", "preparing", "committing", "atomic-delegated", "cancelling", "complete", "aborted"] as const;
export function settings(runId: unknown, kind: unknown, count: unknown) {
  if (typeof runId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId) ||
      kind !== "hot" && kind !== "graph" || typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > 10_000) throw new Error("Invalid write-bench scope");
  return {runId, kind, count, graphId: `write-bench-${kind}-${runId}`} as const;
}
export function payload(scope: ReturnType<typeof settings>, raw: unknown) {
  if (!isRecord(raw) || Object.keys(raw).some(key => key !== "index" && key !== "facts") ||
      typeof raw["index"] !== "number" || !Number.isSafeInteger(raw["index"]) || raw["index"] < 0 || raw["index"] >= scope.count) throw new Error("Invalid write-bench index");
  const index = raw["index"];
  const facts = scope.kind === "hot" ? [{source: "agent:write-benchmark", entity: "control:write-bench:settings",
    field: "control:policy:allowed-action", value: {type: "text", value: `action-${index}`}, retraction: false}] : raw["facts"];
  if (scope.kind === "hot" && Object.hasOwn(raw, "facts")) throw new Error("Hot payload cannot be overridden");
  const parsed = parseFactBatch({txId: "poneglyph:tx:00000000-0000-4000-8000-000000000000", facts});
  if (!parsed.ok || parsed.value.facts.length !== (scope.kind === "hot" ? 1 : 3)) throw new Error("Invalid benchmark payload count");
  if (scope.kind === "graph" && parsed.value.facts.some(fact => fact.source !== "fixture:onepiece-fandom" ||
      !fact.entity.startsWith("wiki:onepiece:page:") || !fact.field.startsWith("wiki:page:") || fact.retraction || fact.entity !== parsed.value.facts[0]!.entity)) throw new Error("Graph benchmark accepts only one pinned page subset per transaction");
  if (scope.kind === "graph" && (new Set(parsed.value.facts.map(fact => fact.field)).size !== 3 ||
      !parsed.value.facts.some(fact => fact.field === "wiki:page:title" && fact.value.type === "text"))) throw new Error("Graph subset requires one title and three distinct fields");
  return {index, clientRequestToken: `bench:${scope.runId}:${scope.kind}:${index}`, facts: parsed.value.facts.map(factAsJson)};
}
export function classify(status: number, raw: unknown): string {
  if (status === 423) return "contention";
  if (status === 429) return "overloaded";
  if (status === 413) return "capacity";
  if (status === 422) return "aborted";
  if (isRecord(raw) && typeof raw["error"] === "string" && /overloaded/i.test(raw["error"])) return "overloaded";
  return status >= 500 ? "unavailable" : "rejected";
}
