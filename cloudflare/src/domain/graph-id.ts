import { parsed, rejected, type ParseResult } from "./result.js";

declare const graphIdBrand: unique symbol;

export type GraphId = string & { readonly [graphIdBrand]: "GraphId" };

export function parseGraphId(input: unknown, path = "graphId"): ParseResult<GraphId> {
  if (typeof input !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(input)) {
    return rejected(path, "expected a lowercase graph ID using letters, digits, and hyphens");
  }
  return parsed(input as GraphId);
}
