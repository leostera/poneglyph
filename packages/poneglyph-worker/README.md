# @leostera/poneglyph-worker

Private, deployable Workers RPC service for canonical Poneglyph storage. No public custom domain, workers.dev, preview URL, HTTP database endpoint or second storage implementation.

```ts
using graph = await env.PONEGLYPH.getGraph({ graphId: "onepiece" });
const result = await graph.query('wiki:page:title(Page, "Monkey D. Luffy")');
// Only a binding principal with write permission can do this:
await graph.transact(facts, { txId: "my-app:operation:one" });
```

The binding's deployment-controlled `props.clientId` identifies the application. Deployment-owned JSON grants map that identity to allowed graphs and `read`/`write` permissions. Missing/malformed identity/policy, unknown clients and ungranted graphs deny access before storage. The generic runtime contains no application names or One Piece rules; the initial grants live in `cloudflare.config.ts`.

Read handles expose the same typed method shape but their write methods **always deny on the server**, before parsing facts or accessing storage. This is not advisory metadata/TypeScript enforcement. A write-enabled subclass supplies the canonical write operation. Handle acquisition does not create durable state. Handles delegate their captured authority when shared and do not survive the caller's invocation; dispose them with `using`. Static grants are captured at acquisition, not an immediate-revocation control plane.

RPC writes require an explicit original `txId`; retain the exact payload plus service/graph identity before sending. RPC failure/disconnection/timeout is not proof of abort or acknowledgement. There are no automatic retries. RPC accepts no `AbortSignal`; HTTP clients retain their existing signal support. Results preserve complete tagged rows, duplicates, snapshot meaning and access metrics.

`poneglyph.svc.leostera.dev` is a logical service name, **not a registered public custom domain**. Consumers use service bindings, not DNS. See [RFD0006](../../docs/rfds/RFD0006-public-read-only-mcp-playground.md) for policy trust, RPC boundaries, rollout and evidence limitations.

```sh
# From repository root; default gates remain offline.
bun run build:package
bun run --cwd packages/poneglyph-worker check
bun run --cwd packages/poneglyph-worker build
# Explicit cloud operation, requires authorization:
bun run --cwd packages/poneglyph-worker deploy
```

This private package exports Worker source/config for in-workspace cf composition. It is not a new published npm storage-embedding API. The old canonical validation Worker/harness remains separate; this service does not expose its testing/admin routes.
