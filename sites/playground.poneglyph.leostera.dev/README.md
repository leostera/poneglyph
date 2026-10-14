# One Piece MCP playground

Tiny read-only MCP application, protected by Cloudflare Access for members of the owner's personal Cloudflare account. Its entrypoint composes `createPublicPoneglyphMcpWorker` with dataset guidance, IP-rate admission and a private `PONEGLYPH` RPC binding. There is no query editor, hosted chat model or separate database API key.

```ts
using graph = await env.PONEGLYPH.getGraph({ graphId: "onepiece" });
```

The reusable MCP package manages that graph's per-tool lifetime. The private `packages/poneglyph-worker` service enforces the playground principal's read-only graph grant; writes are denied independently of the MCP tool list. No database actors/HTTP client adapter live in this site.

The current hostname is `onepiece.poneglyph.dev`. Only a tiny **synthetic smoke fixture, not an imported wiki corpus**, is authorized; this hostname check does not establish the current service's population or completed ingestion. The original dedicated database's private fixture reads are not authenticated MCP success on the generic service. [RFD0006](../../docs/rfds/RFD0006-public-read-only-mcp-playground.md) records exact deployment/cutover state and limitations.

## Offline development

```sh
# Repository root:
bun install --frozen-lockfile
bun run build:package
bun run --cwd sites/playground.poneglyph.leostera.dev check
bun run --cwd sites/playground.poneglyph.leostera.dev build
```

Root build/check/test includes the service, adapter and site. Node hosts native tests against real canonical SQLite actors with six synthetic facts, not cloud resources/corpus data. `dev` uses the referenced service locally with ignored persistence. `dev:seed` is an explicit authenticated remote operator mode, pinned to `127.0.0.1:8878`; it never runs in default gates. Verify the owned listener before calling it. `/seed` submits only the fixed manifest in `src/test-facts.ts`; `/verify` executes three fixed private reads. Neither is part of the public deployment.

`bun run deploy` builds dependencies and deploys the central private service before the public Worker. A new service means fresh namespaces, not automatic migration; never mistake seeding a distinct service for reconciliation against the old database. Keep uncertain original IDs/payloads and stop instead of silently retrying. Deployment/full corpus ingestion/deletion remain explicit operations requiring authorization.

## Connecting an agent

```text
https://onepiece.poneglyph.dev/mcp
```

Sign in using a Cloudflare account that is a member of the owner's personal account. The Worker-scoped Access app uses only the Cloudflare IdP and an explicit Cloudflare Account Member selector; email-PIN login, email allowlists, Everyone and service-token grants are excluded. Workers.dev and preview URLs remain disabled. Your MCP transport must support Access authentication; browser sign-in alone does not authenticate a separate agent process. Call `describe_dataset` first; fixture data is not verified wiki lore. MCP POSTs have an approximate **30/minute per-IP, per-Cloudflare-location** allowance; `429` includes `Retry-After: 60`. Shared IPs share allowance. Native query budgets remain unchanged, and errors never become truncated successes. The generic handler's wildcard CORS is not an Access exemption or a promise of cross-origin cookie authentication. Local native tests bypass the cloud Access edge; deployment verification must read back the policy and check unauthenticated ingress separately.
