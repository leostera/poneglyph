<p align="center">
  <h1>
    <img src="assets/poneglyph.svg#svgView(viewBox(240,240,560,560))" alt="Poneglyph" width="64" height="64">
    Poneglyph
  </h1>
</p>

## What Poneglyph is

Poneglyph is an experimental, embeddable semantic graph database for Cloudflare Workers. It helps an application keep durable knowledge that is more useful as connected facts than as isolated records or a growing prompt: who owns a task, which service it blocks, where a decision came from, and what has changed since.

Poneglyph is a database library/runtime for product teams building their own Worker applications—not a hosted database service, agent, or end-user app. This branch contains the TypeScript prototype backed by SQLite Durable Objects. The scoped npm package, [`@leostera/poneglyph`](poneglyph/README.md), includes portable fact and Datalog primitives plus a typed HTTP client for the prototype's Worker API; it does not bundle or expose the Durable Object storage runtime for direct embedding.

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

Use the local URL printed by `pnpm dev` as `PONEGLYPH_URL`, then run the typed client example in a second terminal:

```sh
cd poneglyph
PONEGLYPH_URL=http://127.0.0.1:5173 pnpm exec tsx ../examples/client-quickstart.ts
```

The example uses `createDatabase`, defines a graph-scoped handle, writes facts with a caller-provided idempotency key, and runs a Datalog query. The Worker API also supports a point entity read at `/v1/graphs/{graphId}/entities?uri=...`. Graph IDs use lowercase letters, digits, and hyphens. Query results include the committed snapshot sequence.

Every graph currently has one coordinator Durable Object. All clients using the same graph ID contend on that coordinator for writes (and use it to begin reads); sharding distributes stored facts but does not distribute the graph's commit sequencer. Cloudflare documents approximately 1,000 requests/second per DO as a soft, workload-dependent limit, not a guaranteed rate or hard ceiling. Actual Poneglyph write throughput must be measured for the workload. Using multiple graph IDs creates separate graphs and changes cross-graph query/transaction semantics; it is not transparent scale-out.

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

The [Cloudflare operations and validation sections in RFD0004](docs/rfds/RFD0004-expandable-cloudflare-sharding.md#local-operating-and-review-gates) covers runtime configuration, isolated deployment validation, cost/evidence limits, and cleanup. Do not run large capacity or throughput experiments against a shared or production deployment.

## Prototype status and limits

This is an experimental `0.1.0` implementation, not a released compatibility promise or a production SLA. Writes serialize through one coordinator per graph; a transaction can involve at most 32 shard leaves; broad queries are capped at 256 leaves. The 8 GB per-Durable-Object figure is an application-level accounted-byte policy, not a measured physical storage cap. The 1 TB exercise is synthetic accounting that writes zero payload rows. The Cloudflare run was a small smoke test, not evidence of production capacity or tail latency.

## Technical details

The existing [RFDs](docs/rfds/) are authoritative for design decisions and contracts. READMEs provide orientation and runnable examples; they do not define a separate design contract.

See the [write-path experiment](docs/rfds/RFD0005-write-path-experiment.md) and [final local benchmark results](bench/write-path/results/README.md) for the corrected implementation's scoped correctness baseline and incomplete concurrent loads.

For the typed fact model, storage and transaction internals, query behavior, limits, benchmarks, and PlusCal/TLA+ model checks, see the latest [RFD0004](docs/rfds/RFD0004-expandable-cloudflare-sharding.md). It distinguishes implementation guarantees from synthetic simulations and bounded Cloudflare evidence. RFD0003 documents the earlier fixed-leaf checkpoint; historical Rust architecture records describe prior designs, not this branch's implementation.
