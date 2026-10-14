<p align="center">
  <h1>
    <img src="assets/poneglyph.svg#svgView(viewBox(240,240,560,560))" alt="Poneglyph" width="64" height="64">
    Poneglyph
  </h1>
</p>

## What Poneglyph is

Poneglyph is an experimental, embeddable semantic graph database for Cloudflare Workers. It helps an application keep durable knowledge that is more useful as connected facts than as isolated records or a growing prompt: who owns a task, which service it blocks, where a decision came from, and what has changed since.

Poneglyph is a database library/runtime for product teams building their own Worker applications—not a hosted database service, agent, or end-user app. This branch contains the TypeScript prototype backed by SQLite Durable Objects. The scoped npm package, [`@leostera/poneglyph`](packages/poneglyph/README.md), includes portable fact and Datalog primitives plus a typed HTTP client for the prototype's Worker API; it does not bundle or expose the Durable Object storage runtime for direct embedding.

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

## Workspace

This is a Bun workspace. Install **Bun 1.4.2** and **Node.js 26**: Bun manages dependencies and scripts; Node runs the Cloudflare/Vitest/Miniflare harnesses.

| Package | Purpose |
| --- | --- |
| [`packages/poneglyph`](packages/poneglyph/) | Library, client and canonical database Worker |
| [`packages/conformance`](packages/conformance/) | Independent correctness oracle and disk-backed E2E harness |
| [`packages/write-path-bench`](packages/write-path-bench/) | Private write-path benchmark harness |
| `examples/*` | Six individually built, typechecked and offline-tested examples |

One root `bun.lock` pins dependencies. Private harnesses link the library with `workspace:*`, consuming its built package exports. From the repository root:

```sh
bun install --frozen-lockfile
bun run check          # all package types, unit/adapter tests and offline example tests
bun run build          # portable package + local Worker + all six example bundles
bun run test:focused   # focused warm/cold E2E regressions
# bun run test:small   # explicit full 68-case warm/cold checkpoint
```

Use `bun run test`, not Bun's built-in `bun test`: the native Worker tests use Vitest and the harness units use Node's test runner. Benchmark loads, deployments and publishing remain separate explicit operations.

## Try it locally

The repository includes a runnable Worker prototype with an HTTP API. Start it locally (no Cloudflare account resources are created):

```sh
bun install --frozen-lockfile
bun run check
bun run dev
```

Use the local URL printed by `bun run dev` as `PONEGLYPH_URL`, then run the typed client example in a second terminal:

```sh
PONEGLYPH_URL=http://127.0.0.1:5173 bun run --cwd examples/client-quickstart run
```

Each example has its own `build`, `typecheck`, `check`, `test` and explicit `run` command. The default workspace gates never run the cloud smoke/load entrypoints. The quickstart uses `createDatabase`, defines a graph-scoped handle, writes facts with a caller-provided idempotency key, and runs a Datalog query. The Worker API also supports a point entity read at `/v1/graphs/{graphId}/entities?uri=...`. Graph IDs use lowercase letters, digits, and hyphens. Query results include the committed snapshot sequence.

There is one storage implementation under `packages/poneglyph/src/storage/`, promoted from G. Each graph has a request facade, sixteen entity-owner roots and sixteen pooled transaction ledgers. Conflicting entities and topology changes are fenced; independent owners may progress concurrently. Queries use a leased owner vector—not one graph-global commit order. This is still experimental: neither universal correctness nor full-delivery/hosted performance is established. See [the canonical implementation decision](docs/rfds/RFD0005-write-path-experiment.md#current-direction-one-implementation-2026-10-14). Multiple graph IDs remain separate graphs, not transparent partitions.

## Deploying to Cloudflare

Deploy only after the local checks pass and after adapting [`packages/poneglyph/cloudflare.config.ts`](packages/poneglyph/cloudflare.config.ts) to resources you control. Its checked-in Worker name and hostname belong to an isolated validation setup; choose a unique Worker name, hostname, and Durable Object namespaces for your account. Cloudflare deployment creates billable resources.

```sh
cd packages/poneglyph
bun run cf auth whoami
bun run check
bun run build
bun run cf deploy --dry-run
bun run deploy
```

The [Cloudflare operations and validation material in RFD0004](docs/rfds/RFD0004-expandable-cloudflare-sharding.md#local-operating-and-review-gates) covers runtime configuration, isolated deployment validation, cost/evidence limits, and cleanup. Do not run large capacity or throughput experiments against a shared or production deployment.

## Prototype status and limits

This is an experimental `0.1.0` implementation, not a released compatibility promise or a production SLA. Conflicting entities are fenced by owner reservations; independent owners may progress concurrently. A transaction can involve at most 32 shard leaves; broad queries are capped at 256 leaves. The 8 GB per-Durable-Object figure is an application-level accounted-byte policy, not a measured physical storage cap. The 1 TB exercise is synthetic accounting that writes zero payload rows. The Cloudflare run was a small smoke test, not evidence of production capacity or tail latency.

## Technical details

The existing [RFDs](docs/rfds/) are authoritative for design decisions and contracts. READMEs provide orientation and runnable examples; they do not define a separate design contract.

See the [write-path experiment](docs/rfds/RFD0005-write-path-experiment.md) and [final local benchmark results](packages/write-path-bench/results/README.md) for the corrected implementation's scoped correctness baseline and incomplete concurrent loads.

For the typed fact model, storage and transaction internals, query behavior, limits, benchmarks, and PlusCal/TLA+ model checks, see the latest [RFD0004](docs/rfds/RFD0004-expandable-cloudflare-sharding.md). It distinguishes implementation guarantees from synthetic simulations and bounded Cloudflare evidence. RFD0003 documents the earlier fixed-leaf checkpoint; historical Rust architecture records describe prior designs, not this branch's implementation.
