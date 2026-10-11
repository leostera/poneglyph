# Review Readiness

This branch is an experimental TypeScript/Cloudflare Poneglyph package. The fixed-four-leaf checkpoint is implemented and locally testable; expandable sharding, capacity accounting, and the authenticated TODO demo are follow-on work tracked by the active goal and [RFD0004](rfds/RFD0004-expandable-cloudflare-sharding.md). Do not describe planned mechanisms as shipped until their tests and measurements exist.

## Review scope

- Strict-TypeScript graph and Datalog semantics in `poneglyph/`.
- SQLite-backed Durable Object coordinator/shard storage and transaction visibility.
- Local workerd/Miniflare integration tests and repeatable One Piece load/query harnesses.
- Small PlusCal/TLA+ models in `specs/` for visibility and split/recovery invariants.
- Any demo HTTP/WebSocket boundary, including authentication and post-commit invalidations.

The previous Rust implementation and Cargo workspace have been removed from this branch only. Git history and other branches are unchanged. Historical Rust-oriented RFDs remain in `docs/rfds/` as records of earlier decisions, not current implementation instructions.

## Local review gates

```sh
cd poneglyph
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

For the formal models, install a JDK and a pinned TLA+ tools JAR, then run:

```sh
TLA2TOOLS_JAR=/path/to/tla2tools.jar ./specs/check.sh
```

The root CI workflow runs the package checks/build and the model checker. Real-data load/query and synthetic capacity runs are separate from quick unit tests; see [`poneglyph/README.md`](../poneglyph/README.md) for commands and recorded results. Cloudflare account tests are allowed only after local gates pass and must use an isolated hostname under `*.poneglyph.leostera.dev`.

## Review invariants

- Facts and retractions are append-only; entity/index projections are derived and replayable.
- A transaction becomes visible only when the graph coordinator publishes its sequence after every participant applies.
- A read pins one sequence and (after dynamic routing is implemented) one directory epoch; it cannot mix owners or commit visibility.
- Split/cutover keeps the source authoritative until an atomic, durable directory update; recovery never reverses a committed cutover.
- Storage admission includes fact/index/projection growth, WAL and transaction staging, migration workspace, and reserved headroom before accepting writes.
- HTTP and WebSocket access to the shared TODO demo use the same passphrase authentication boundary; notifications are emitted only after transaction visibility.
- Synthetic capacity arithmetic is not physical storage evidence. Report its assumptions separately from real workerd or Cloudflare runs.

## Scope boundaries

Do not add general-purpose Datalog optimization, historical/as-of queries, schema evolution, global replication, source connectors, or modifications to FokosDB without a separate proposal. Do not physically load 50 GB or 1 TB. Keep Cloudflare resource cleanup limited to resources created for validation.
