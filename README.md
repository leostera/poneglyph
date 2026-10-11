<p align="center">
  <h1>
    <img src="assets/poneglyph.svg#svgView(viewBox(240,240,560,560))" alt="Poneglyph" width="64" height="64">
    Poneglyph
  </h1>
</p>

Poneglyph is an experimental semantic knowledge graph database for Cloudflare Workers. This branch contains a strict-TypeScript implementation backed by SQLite Durable Objects; it no longer contains the earlier Rust workspace. Rust source and commits remain in Git history and on other branches.

## Data model

Poneglyph's durable truth is an append-only fact log. A fact states that an entity has a field with a value. Updates and deletions append new facts (including retractions); they do not mutate historical facts. Active facts, entity views, and indexes are derived projections that can be rebuilt from the log.

The TypeScript package implements typed fact parsing, a bounded positive Datalog subset, SQLite-backed Durable Object storage, cross-shard transaction coordination, versioned read snapshots, and query budgets. Its completed checkpoint uses one graph coordinator and four fixed entity-hash leaves. That topology is a prototype, not an aggregate capacity claim. Expandable directory routing, split/cutover, storage accounting, and migration recovery are specified—but not yet implemented—in [RFD0004](docs/rfds/RFD0004-expandable-cloudflare-sharding.md).

## Package and examples

- [`poneglyph/`](poneglyph/) — strict TypeScript Cloudflare Workers/Durable Objects package and its complete local/deployment guide.
- [`examples/onepiece-load.ts`](examples/onepiece-load.ts) — repeatable local real-data ingest/query harness.
- [`examples/deployed-smoke.ts`](examples/deployed-smoke.ts) — bounded isolated deployment smoke test.
- [`specs/`](specs/) — small PlusCal/TLA+ models for transaction visibility and shard split/cutover, checked with TLC.

See [RFD0003](docs/rfds/RFD0003-cloudflare-native-graph-database.md) for the fixed-leaf checkpoint and [RFD0004](docs/rfds/RFD0004-expandable-cloudflare-sharding.md) for the scale-out proposal. Historical Rust architecture RFDs are retained as prior design records, not as the current branch implementation contract.

## Local development

Requires Node.js 26 and pnpm 12. From the package directory:

```sh
cd poneglyph
pnpm install
pnpm check      # generated Cloudflare types, strict TypeScript, local integration/unit tests
pnpm build
pnpm dev        # local Vite/workerd server
```

The tests use local workerd/Miniflare and create no Cloudflare account resources. The One Piece workload setup, pinned input checksums, commands, and latest checkpoint measurements are in [`poneglyph/README.md`](poneglyph/README.md).

## Formal model checks

The transaction and migration PlusCal algorithms are in `specs/`; their checked invariants and model limitations are documented in [`specs/README.md`](specs/README.md). To run TLC, install a JDK and provide a local TLA+ tools JAR:

```sh
TLA2TOOLS_JAR=/path/to/tla2tools.jar ./specs/check.sh
```

GitHub Actions runs the strict TypeScript package checks/build and the pinned formal models. No Rust toolchain, Cargo workspace, or Datafox sibling checkout is required on this branch.
