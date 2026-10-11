<p align="center">
  <h1>
    <img src="assets/poneglyph.svg#svgView(viewBox(240,240,560,560))" alt="Poneglyph" width="64" height="64">
    Poneglyph
  </h1>
</p>

## What Poneglyph is

Poneglyph is an experimental, embeddable semantic graph database for Cloudflare Workers. It helps an application keep durable knowledge that is more useful as connected facts than as isolated records or a growing prompt: who owns a task, which service it blocks, where a decision came from, and what has changed since.

Poneglyph is a database library/runtime for product teams building their own Worker applications—not a hosted database service, agent, or end-user app. This branch contains the TypeScript prototype backed by SQLite Durable Objects. The planned scoped npm package, [`@leostera/poneglyph`](poneglyph/README.md), currently exposes the portable fact and Datalog core; the Durable Object storage runtime is not yet a supported npm API.

## What you can build with it

Poneglyph is a fit for application data whose value comes from relationships and provenance, for example:

- Shared memory for agents across sessions: people, projects, documents, decisions, and their sources.
- Team workflows: tasks, owners, dependencies, release readiness, and related services.
- A connected knowledge map: concepts and references that can be queried together instead of copied into denormalized blobs.

These are application patterns, not prebuilt products. Your application defines its own entities, fields, and rules.

## What it gives your application

- **Traceable facts:** write assertions with a source and transaction ID; represent corrections as new evidence rather than erasing history.
- **Relationship queries:** ask questions that join facts across entities, using Poneglyph's bounded Datalog subset.
- **Atomic changes:** a multi-entity transaction becomes visible as one commit, rather than exposing a half-finished move or update.
- **Consistent reads:** each query reads one committed snapshot, even while writes or shard maintenance continue.
- **Derived views:** get current entity views and query indexes built from the durable facts.

Poneglyph favors those semantics over a general-purpose SQL surface, an analytics warehouse, or unbounded queries. It is still a prototype; see [the limits](#prototype-status-and-limits) before choosing it for a workload.

## Try it locally

The repository includes a runnable Worker prototype with an HTTP API. Start it locally (no Cloudflare account resources are created):

```sh
cd poneglyph
pnpm install
pnpm check
pnpm dev
```

Use the local URL printed by `pnpm dev` as `PONEGLYPH_URL`. This example records a task, its owner, and the service it blocks in one transaction:

```sh
export PONEGLYPH_URL=http://127.0.0.1:5173 # replace with the URL printed by pnpm dev

curl -sS "$PONEGLYPH_URL/v1/graphs/release-assistant/transactions" \
  -H 'content-type: application/json' \
  -d '{
    "txId": "release:seed-001",
    "facts": [
      {
        "source": "agent:release-assistant",
        "entity": "app:service:auth-api",
        "field": "app:service:blocked-by",
        "value": { "type": "reference", "value": "app:task:rotate-key" },
        "retraction": false
      },
      {
        "source": "agent:release-assistant",
        "entity": "app:task:rotate-key",
        "field": "app:task:status",
        "value": { "type": "text", "value": "open" },
        "retraction": false
      },
      {
        "source": "agent:release-assistant",
        "entity": "app:task:rotate-key",
        "field": "app:task:owner",
        "value": { "type": "reference", "value": "app:person:ari" },
        "retraction": false
      }
    ]
  }'
```

Then query for open tasks that block a service and return their owner:

```sh
curl -sS "$PONEGLYPH_URL/v1/graphs/release-assistant/query" \
  -H 'content-type: application/json' \
  -d '{"query":"app:service:blocked-by(Service, Task), app:task:status(Task, \"open\"), app:task:owner(Task, Owner)"}'
```

The Worker API also supports a point entity read at `/v1/graphs/{graphId}/entities?uri=...`. Graph IDs use lowercase letters, digits, and hyphens. The transaction and query routes return commit/snapshot information alongside their results; use those sequence numbers to associate a response with the change it observes.

## Deploying to Cloudflare

Deploy only after the local checks pass and after adapting [`poneglyph/cloudflare.config.ts`](poneglyph/cloudflare.config.ts) to resources you control. Its checked-in Worker name and hostname belong to an isolated validation setup; choose a unique Worker name, hostname, and Durable Object namespaces for your account. Cloudflare deployment creates billable resources.

```sh
cd poneglyph
pnpm exec cf auth whoami
pnpm run check
pnpm run build
pnpm exec cf deploy --dry-run
pnpm run deploy
```

The [Cloudflare operations guide](poneglyph/OPERATIONS.md) covers runtime configuration, isolated deployment validation, cost/evidence limits, and cleanup. Do not run large capacity or throughput experiments against a shared or production deployment.

## Prototype status and limits

This is an experimental `0.1.0` implementation, not a released compatibility promise or a production SLA. Writes serialize per graph; a transaction can involve at most 32 shard leaves; broad queries are capped at 256 leaves. The 8 GB per-Durable-Object figure is an application-level accounted-byte policy, not a measured physical storage cap. The 1 TB exercise is synthetic accounting that writes zero payload rows. The Cloudflare run was a small smoke test, not evidence of production capacity or tail latency.

## Videos and technical details

- [Why Poneglyph?](examples/poneglyph-why.mp4) — use cases, user-facing guarantees, and trade-offs.
- [How Poneglyph works](examples/poneglyph-how-it-works.mp4) — writes, reads, distributed queries, sharding, and recovery.
- [Interactive explainer](examples/interactive-explainer.html) — a browser-based visual guide.

For the typed fact model, storage and transaction internals, query behavior, limits, benchmarks, and PlusCal/TLA+ model checks, see the latest [RFD0004](docs/rfds/RFD0004-expandable-cloudflare-sharding.md). It distinguishes implementation guarantees from synthetic simulations and bounded Cloudflare evidence. RFD0003 documents the earlier fixed-leaf checkpoint; historical Rust architecture records describe prior designs, not this branch's implementation.
