# @leostera/poneglyph-worker

Private, deployable Workers RPC service for canonical Poneglyph storage. No public custom domain, workers.dev, preview URL, HTTP database endpoint or second storage implementation.

```ts
using graph = await env.PONEGLYPH.getGraph({ graphId: "onepiece" });
const result = await graph.query('wiki:page:title(Page, "Monkey D. Luffy")');
// Only a binding principal with write permission can do this:
const receipt = await graph.transact(facts, {clientRequestToken: "my-app:operation:one"});
// receipt is exactly { txId }, minted by the service after commit.
```

The binding's deployment-controlled `props.clientId` identifies the application. Deployment-owned JSON grants map that identity to allowed graphs and `read`/`write` permissions. Missing/malformed identity/policy, unknown clients and ungranted graphs deny access before storage. The generic runtime contains no application names or One Piece rules; the initial grants live in `cloudflare.config.ts`.

Read handles expose the same typed method shape but their write methods **always deny on the server**, before parsing facts or accessing storage. This is not advisory metadata/TypeScript enforcement. A write-enabled subclass supplies the canonical write operation. Handle acquisition does not create durable state. Handles delegate their captured authority when shared and do not survive the caller's invocation; dispose them with `using`. Static grants are captured at acquisition, not an immediate-revocation control plane.

Public RPC writes mint internal transaction IDs on the service and return only `{ txId }` after commit. To replay one logical request after uncertain delivery, retain and resend the same `clientRequestToken` (up to 256 UTF-8 bytes) and exact facts; it is graph-scoped and retained for seven days, subject to bounded capacity. Changed facts conflict. RPC failure/disconnection/timeout does not prove abort, and errors do not disclose an internal transaction ID. There are no automatic retries. RPC accepts no `AbortSignal`; HTTP clients retain their existing signal support. Results preserve complete tagged rows, duplicates, snapshot meaning and access metrics. The separate trusted `transactApprovedBatch` service operation is reserved for approved import plans and is not part of the public `GraphClient` API.

`poneglyph.svc.leostera.dev` is a logical service name, **not a registered public custom domain**. Consumers use service bindings, not DNS. See [RFD0006](../../docs/rfds/RFD0006-public-read-only-mcp-playground.md) for policy trust, RPC boundaries, rollout and evidence limitations.

```sh
# From repository root; default gates remain offline.
bun run build:package
bun run --cwd packages/poneglyph-worker check
bun run --cwd packages/poneglyph-worker build
# Explicit cloud operation, requires authorization:
bun run --cwd packages/poneglyph-worker deploy
```

## Isolated control-plane validation deployment

The `mavplus-validation` cf mode selects the existing private `poneglyph-mavplus-validation-worker` name and its existing four Durable Object classes/namespaces. It adds one graph-scoped grant: `playground-loader` may read/write `control-plane-validation`. The default mode still selects `poneglyph-service-worker` with its existing grants. The validation Worker has no public domain, workers.dev, or preview URL. Deploying this mode changes only the isolated Worker version and its authorization JSON; it does not create test facts or run the live test.

```sh
cd packages/poneglyph-worker
cf deploy --mode mavplus-validation --dry-run
# Only after verifying the selected Worker/config and receiving explicit approval:
cf deploy --mode mavplus-validation --message "isolated control-plane test grant"
```

This private package exports Worker source/config for in-workspace cf composition. It is not a new published npm storage-embedding API. The old canonical validation Worker/harness remains separate; this service does not expose its testing/admin routes.
