import type { DatalogQuery } from "../datalog/ast.js";
import { evaluateDatalog } from "../datalog/evaluator.js";
import type { FactSource } from "../datalog/fact-source.js";
import { QueryScanBudgetExceeded } from "../datalog/scan-stream.js";
import type { DatalogValue } from "../datalog/value.js";
import { MAX_QUERY_RESPONSE_BYTES, MAX_QUERY_RESULTS } from "./constants.js";
import { utf8Bytes } from "./read-cache.js";

export type QueryRows = Record<string, DatalogValue>[];

/** Materialize the complete bag or throw; callers still own leases and cleanup. */
export async function collectQueryRows(query: DatalogQuery, source: FactSource, signal: AbortSignal): Promise<QueryRows> {
  const rows: QueryRows = [];
  let responseBytes = 0;
  for await (const binding of evaluateDatalog(query, source, {maxResults: MAX_QUERY_RESULTS, signal})) {
    const row = Object.fromEntries(binding);
    responseBytes += utf8Bytes(JSON.stringify(row)) + 1;
    if (responseBytes > MAX_QUERY_RESPONSE_BYTES) throw new QueryScanBudgetExceeded("query response byte budget exceeded");
    rows.push(row);
  }
  return rows;
}
