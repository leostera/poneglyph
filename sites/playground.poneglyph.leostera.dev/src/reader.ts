import { createDatabase } from "@leostera/poneglyph";
import { GRAPH_ID } from "./dataset.js";
import type { GraphReader } from "./mcp.js";

export function createGraphReader(service: Pick<Fetcher, "fetch">): GraphReader {
  const graph = createDatabase({
    // A service-binding routing label, never an Internet fetch destination.
    url: "https://database.internal",
    graphId: GRAPH_ID,
    fetch: (input, init) => service.fetch(input, init),
  });
  // The MCP layer gets a read capability, not a client with transact/state.
  return Object.freeze({ query: (source, options) => graph.query(source, options) });
}
