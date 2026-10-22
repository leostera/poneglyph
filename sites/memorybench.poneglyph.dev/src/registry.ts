import { createHash } from "node:crypto";
import manifest from "../evidence/datasets.json" with { type: "json" };
export type Benchmark = "locomo" | "longmemeval";
export type Variant = "a" | "b";
export type GraphScope = Readonly<{ graphId: string; benchmark: Benchmark; variant: Variant; container: string; datasetHash: string }>;

export function graphName(benchmark: Benchmark, variant: Variant, container: string): string {
  return `memorybench-${benchmark}-${variant}-${createHash("sha256").update(container).digest("hex").slice(0, 24)}`;
}
function registry(): ReadonlyMap<string, GraphScope> {
  const entries = new Map<string, GraphScope>();
  for (const dataset of manifest.datasets) {
    if (dataset.benchmark !== "locomo" && dataset.benchmark !== "longmemeval") throw new Error("Invalid pinned benchmark");
    for (const variant of ["a", "b"] as const) for (const container of dataset.containers) {
      const graphId = graphName(dataset.benchmark, variant, container);
      if (entries.has(graphId)) throw new Error("Graph name collision");
      entries.set(graphId, Object.freeze({ graphId, benchmark: dataset.benchmark, variant, container, datasetHash: dataset.sha256 }));
    }
  }
  return entries;
}
export const GRAPH_SCOPES = registry();
export function selectGraph(value: string | null): GraphScope | undefined {
  return value === null ? undefined : GRAPH_SCOPES.get(value);
}
export const GRAPH_HEADER = "x-memorybench-graph";
export { HOST, COMPATIBILITY_DATE } from "./runtime.js";
