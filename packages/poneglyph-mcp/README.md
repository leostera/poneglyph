# @leostera/poneglyph-mcp

Reusable read-only MCP tools and stateless HTTP handling for Poneglyph, built with the Cloudflare Agents SDK. This private workspace package has no One Piece dataset, fixed graph, backend binding, hostname or deployment config.

Applications provide a query capability and dataset guidance:

```ts
import { createDatabase } from "@leostera/poneglyph";
import { createPoneglyphMcpHandler } from "@leostera/poneglyph-mcp";

const graph = createDatabase({
  url: "https://database.internal",
  graphId: "my-graph",
  fetch: (input, init) => env.DATABASE.fetch(input, init),
});
const handler = createPoneglyphMcpHandler({
  reader: { query: (source, options) => graph.query(source, options) },
  dataset: { name: "My graph", predicates: ["example:name"], limitations: [] },
  serverInfo: { name: "my-graph-mcp", version: "1.0.0" },
  allowedHostnames: ["my-mcp.example"],
});
// After the application's authentication/rate admission:
return handler.fetch(request);
```

`createPoneglyphMcpServer` exposes the server factory separately for other compositions. Tools are `describe_dataset` and `query`; successful query output preserves complete typed rows/multiplicity, snapshot and metrics. Errors never become truncated successes or automatic retries. The HTTP handler bounds bodies, rejects JSON-RPC batches, and creates fresh Agents SDK server/transport state per request.

The owner supplies ingress policy, CORS, rate limiter, graph/backend selection, resource bindings, static website and deployment lifecycle. Reusing the package does not create a new database implementation or grant clients write access. The [playground](../../sites/playground.poneglyph.leostera.dev/) is one consumer; [RFD0006](../../docs/rfds/RFD0006-public-read-only-mcp-playground.md) records the boundary and its first deployment.

```sh
# From repository root; Node runs the tests.
bun run build:package
bun run --cwd packages/poneglyph-mcp check
```

Root build/check/test includes this package. This is private until a separate publication decision; no npm publication is implied.
