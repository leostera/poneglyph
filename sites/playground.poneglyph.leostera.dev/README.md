# One Piece MCP playground

A public, anonymous, read-only MCP application built with Cloudflare's Agents SDK and Poneglyph. `/` gives connection instructions; `/mcp` exposes `describe_dataset` and `query`. There is no query editor, hosted chat model, login or API key.

**Local implementation only: not deployed, and no full wiki corpus has been loaded into its dedicated database.** Tests seed six synthetic facts. The intended corpus is the existing normalized wiki metadata/link graph, not full article text or verified lore.

[Architecture, security, rate limits and rollout](../../docs/rfds/RFD0006-public-read-only-mcp-playground.md).

## Offline development

From the repository root:

```sh
bun install --frozen-lockfile
bun run build:package
bun run --cwd sites/playground.poneglyph.leostera.dev check
bun run --cwd sites/playground.poneglyph.leostera.dev build
```

Root `bun run check`, `bun run test` and `bun run build` also include the site. Tests use Node and a tiny local Miniflare/SQLite runtime, never cloud resources or the cached wiki dump. The build checks both private database and public MCP modes, leaving the public build output last.

For interactive local development, run `dev:database` and `dev` in separate terminals from this package. Both use ignored `.artifacts/dev` persistence; use the printed local MCP URL, not the undeployed production hostname. The database exposes transactions only on that local/private Worker; the public application never forwards them. Corpus ingestion and verification remain a separate operator step.

## Connecting an agent

Once an approved deployment and verified corpus load exist, use remote MCP / Streamable HTTP at:

```text
https://playground.poneglyph.leostera.dev/mcp
```

No credentials are required. First call `describe_dataset`, then for example:

```json
{"query":"wiki:page:title(Page, \"Monkey D. Luffy\"), wiki:page:category(Page, Category)"}
```

MCP POST requests have an approximate **30/minute per-IP, per-Cloudflare-location** allowance; `429` includes `Retry-After: 60`. Shared IPs share the allowance. Native query budgets still apply, with explicit failures instead of truncated success. Wildcard, credential-free CORS supports browser-based agents.

Deployment scripts are explicit operations, not authorization. Before deployment, verify names/namespace collisions, account/billing limits and corpus size, and preserve the database Worker's lack of public routes, workers.dev and preview URLs. No cloud or full-load action is performed by default scripts.
