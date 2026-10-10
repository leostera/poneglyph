# RFD0003: Cloudflare-Native Graph Database

## Status

Draft.

## Summary

This RFD proposes a Cloudflare-native, Datomic-inspired Poneglyph implementation: strict TypeScript on Workers, SQLite-backed Durable Objects for durable graph partitions, an append-only fact log, and a bounded distributed Datalog evaluator. Durable Object routing and repartitioning should learn from FokosDB without adopting its DynamoDB-shaped data model. A `txId` identifies one write batch and defines its all-or-nothing visibility boundary. Because DO storage transactions are local to one object, the first design uses explicit cross-DO coordination and prevents graph queries from observing a partially applied transaction. The implementation protocol must be proven locally before deploying isolated tests to a personal Cloudflare account.

## Context

Poneglyph currently is a Rust workspace. `Fact` records include a fact id, source, entity, field, value, retraction flag, statement time, and optional transaction id (`crates/poneglyph/src/fact.rs`). Local SQLite applies an incoming batch to both the append-only fact log and active-fact view in one SQL transaction (`crates/poneglyph-local/src/facts/sqlite.rs`). Active facts are retrievable by entity, field, field+entity, field+value, and field+entity+value (`crates/poneglyph/src/active_graph.rs`). The query bridge supplies those reads to Datafox `FactRequest`s and consumes Datafox's streaming evaluator (`crates/poneglyph/src/query.rs`).

The local storage and Rust query implementation should remain intact. The Cloudflare path is a separate strict-TypeScript implementation; it is not a promise that the existing Rust workspace can run as a Worker. This allows the Cloudflare code to use the Workers runtime and DO storage model directly while keeping the portable data semantics recognizable.

Cloudflare's SQLite-backed DO storage is transactional and strongly consistent within one DO, but storage is private to that DO [CF1]. A multi-entity fact batch may affect multiple entity shards, and a Datalog join may read multiple shards. Neither a local SQLite transaction nor a per-DO atomic storage call can make those independent databases change atomically. The database therefore needs both a distributed write protocol and a read-visibility contract.

FokosDB is a complementary reference point, not a competitor. Its current public design is DynamoDB-like: hash-key partitions split into child DOs, parent routers forward using durable routing state and learned hints, large hot hash keys can be promoted to range partitions, and a distinct transaction coordinator drives participant prepare/commit/cancel with recovery [F1–F3]. FokosDB explicitly describes itself as unstable and not production-ready at the reviewed snapshot [F1]. Its mechanisms are prior art to study, not proof that its protocol solves Poneglyph's graph-wide query semantics.

## Goals

- Define a database per logical graph, distributed across multiple DOs, with entity-oriented facts and Datalog queries.
- Preserve append-only fact semantics: assertions and retractions are durable facts; active graph and entity views are derived data.
- Define `txId` as a stable identifier for exactly one submitted fact batch and the all-or-nothing visibility boundary for that batch, including updates on every affected DO.
- Provide a strict-TypeScript Workers implementation and a small, explicit Datalog subset with predictable index and fan-out behavior.
- Demonstrate one multi-DO query that pushes partial work to shards, streams results, and joins at a coordinator.
- Use FokosDB and Cloudflare DO documentation to inform routing, migration, transaction recovery, local testing, and deployment choices.
- Keep the existing Rust local backend working and use the One Piece Fandom Wiki workload for repeatable local load and complex-query tests before any account deployment.

## Non-goals

- User-facing historical/as-of queries, schema evolution, global replication, and source connectors.
- A general Datalog optimizer, recursive rules, or unrestricted unbounded scans in the first checkpoint.
- Replacing the Rust/local crates or changing the FokosDB project.
- Assuming that global graph queries are cheap merely because the storage runs on Cloudflare's network.

## Proposed architecture

### Components and placement

1. **Worker API and query/transaction coordinator.** A Worker validates typed requests and sends them to a graph coordinator DO. The coordinator persists graph identity, routing/configuration, transaction decisions, recovery state, and query budgets. All externally visible reads and writes pass through this boundary; shard RPCs are internal and cannot bypass transaction visibility.
2. **Entity partitions.** A partition owns facts for a deterministic subset of entity URIs. Its SQLite-backed DO stores the append-only facts and the local active-fact/entity/index views. A fact batch that touches multiple entities is grouped by owner before prepare. Each partition owns its tables and migrations; a generic sharding layer may own routing and repartition lifecycle, following the useful FokosDB boundary [F2].
3. **Routing tree.** Start from a stable, versioned hash mapping of entity URI to a root/leaf. Compare (a) one DO per graph, (b) fixed entity-hash partitions, and (c) a Fokos-inspired dynamically splitting hash tree. The preferred scale-out direction is (c): a parent that splits becomes a router, children import bounded pages, and durable ownership cutover precedes forwarding/cached route hints. Topology parameters that determine object identity must not change after data exists. A first prototype may use fixed leaves to prove semantics before implementing dynamic split; the RFD decision and initial test must say which is used.

This sharding key co-locates an entity's outgoing assertions and its entity view. It does not make every graph query local: a predicate-only query visits all current leaves, and value/reverse-reference access may require per-leaf indexes or an additional global index. Do not add a global secondary index until its own cross-shard update and retraction cost is included in the transaction participants.

A single entity with unbounded facts can become a hot/oversized key that hash splitting cannot divide without breaking entity locality. The first checkpoint must measure this case and define a limit or reject it; field/value subpartitioning is deferred because it turns one entity read/write into a distributed operation.

### Fact and transaction contract

- A `txId` is an opaque unique transaction identity, not a timestamp and not an `asOf` cursor. A separate idempotency key may be supplied for retry. Reusing a `txId` with a different canonical payload is an error; retrying the same transaction resumes/returns its durable outcome.
- Every submitted batch is non-empty, assigned one `txId`, and routed to all owning partitions. Each participant durably stages facts plus derived active-index/entity updates without exposing them. It also persists enough state to make prepare, commit, cancel, and recovery idempotent.
- A durable coordinator record moves from preparing to a terminal decision. Rejection before the commit decision cancels prepared participants. Once commit is the durable decision, recovery must finish commit; it must not change to cancel. The public write returns committed only after every participant has durably applied the transaction and the coordinator has recorded completion.
- **Visibility invariant:** an external query sees all effects of a committed `txId` or none; it never observes one shard before another. User queries do not select old transaction states, so no user-facing historical API is implied.
- The conservative first implementation is a graph-level visibility barrier: a writer owns the graph's exclusive gate from prepare through all participant acknowledgements and completion; graph queries acquire a read gate and may not run against shards while a commit is unresolved. An in-doubt transaction blocks or receives an explicit retryable response until coordinator recovery finishes. Queries hold a stable read gate across their shard fan-out/join. This deliberately sacrifices per-graph concurrency to establish a correctness baseline.

This gate requires every user-facing path to pass through the coordinator. It is not enough to run 2PC and then let a query read shards independently: participants may apply a committed transaction at different times. The simple gate may become a bottleneck; measure it. If the gate cannot meet the intended workload, investigate versioned participant state plus a shared snapshot/visibility protocol before weakening the invariant. Correctness of all-or-nothing visibility is a release gate, not an optimization detail.

### Query and index contract

The first query representation is a typed AST in strict TypeScript, parsed/validated at the Worker boundary. The supported subset is positive binary fact relations `field(Entity, Value)` joined by conjunction, with URI/string/integer constants, variable unification, list values exposed as individual relation values, and the existing tested pure constraints needed by the One Piece workload (`contains`, `startsWith`, `endsWith`, and scalar comparisons). No negation, recursive rules, implicit historical reads, or arbitrary user code in the evaluator. Query and value semantics need golden tests against current Poneglyph/Datafox results for the supported cases.

Each owner exposes bounded scans for the active fact access shapes: field, entity, field+entity, field+value, and field+entity+value. An entity-bound atom routes directly to its owner. A field-only atom fans out to all live leaves and uses each leaf's local field index. A query with an unbound predicate or a broad value may therefore have cost proportional to shard count and matching facts; make this visible in a plan/explain result. Keep deterministic plan selection, result/tuple/byte/fan-out budgets, backpressure, cancellation, and scan counters explicit. Do not promise result ordering unless requested and implemented.

The distributed proof query decomposes a conjunction into selective shard-local scans and joins streamed substitutions at the coordinator. Bindings from one atom should narrow later reads where the owning key permits it. Use bounded batches and stop/cancel upstream scans when a limit or error is reached. The One Piece suite should include the existing multi-hop crew/island/lore queries and the `contains(Name, " D. ")` query; correctness assertions are stable, while wall-clock benchmarks are recorded separately from CI.

### Local-first validation and Cloudflare deployment

Use the Workers Vitest integration/Miniflare locally for DO storage and binding behavior [CF3]. Local gates must cover fact/property tests, duplicate/retry IDs, rejected prepare/cancel, crashes before/after durable commit decision, partial participant acknowledgements, recovery, read-vs-commit visibility, router split/cutover if implemented, Datalog golden tests, bounded streaming/cancellation, and One Piece ingest/query/load workloads. Run the existing Rust formatting, Clippy, and test gates as regression checks (the workspace additionally requires its sibling Datafox checkout).

Only after local gates pass may account testing begin. Deploy an isolated, clearly named namespace/Worker to the user's personal Cloudflare account. Never alter unrelated existing resources. Run a bounded end-to-end transaction and representative graph-query/load test; record the exact deployment and limits used; delete only resources created for this test. Cloudflare documents per-object storage and CPU/throughput limits; verify current plan-specific limits and billing before selecting the deployed load size [CF2].

## Alternatives

| Option | Benefit | Cost / reason not selected as the whole design |
| --- | --- | --- |
| One DO per graph | Native local transactions and simple Datalog reads; best semantic baseline. | One DO becomes the storage/throughput ceiling and cannot exercise distributed queries. Keep as a correctness oracle or tiny-graph option. |
| Fixed entity-hash partitions | Simple ownership and useful horizontal scale. | Repartitioning requires coordinated migration or rehash; partition count becomes an operational constraint. Useful for the first semantics spike. |
| Dynamic Fokos-style hash tree | Incremental growth, deterministic routing, recoverable bounded migration, and learned route shortcuts. | Router state, splitting, cutover, and route staleness are substantial new correctness surfaces; graph-wide transactions and joins remain Poneglyph's responsibility. Preferred scale-out direction, not copied wholesale. |
| Predicate/field partitioning | Field-only scans can target fewer owners. | One entity's fields and all multi-field updates may cross partitions; writes and retractions expand the 2PC participant set. Evaluate as a secondary index only with measured scan evidence. |
| Rust/Wasm query engine | Reuses Datafox and existing Poneglyph query tests. | The user chose a strict TypeScript Cloudflare implementation/evaluator; preserving a Rust runtime dependency would complicate the clean TS boundary. Revisit only if the TS subset cannot preserve needed semantics. |
| Independent shard reads plus 2PC writes | High read availability and no graph-level query gate. | Can expose partial application across shards without a multi-shard snapshot protocol. Rejected for the initial strong-consistency contract. |

## Consequences and risks

- The coordinator gate is the simplest explicit baseline for the selected visibility contract, but all operations on one graph may serialize or block around transactions. Throughput must be measured with the One Piece workload; this design is not accepted as the final scaling point solely because it is easy to reason about.
- Entity ownership makes common entity reads/writes local but means global field scans fan out. Index additions change both write cost and transaction scope.
- Transaction recovery can block reads while an in-doubt transaction is resolved. Errors and retry behavior must be explicit and bounded.
- Hash partition splits add migration/routing complexity. A split must preserve ownership and pending transaction state; a participant cannot move or duplicate a transaction lock without coordinator-safe routing.
- The current local Rust/Datafox path does not establish TypeScript evaluator parity. Maintain a curated golden corpus from supported existing query semantics.
- FokosDB is useful prior art but is an independently evolving project; inspect its current source and license before any code reuse. Learn concepts and document transferable lessons, not copy implementation details.

## Open questions

1. Can the graph-level gate meet a useful single-graph query/write workload, or is a versioned read-snapshot protocol required before the checkpoint?
2. Should the first Cloudflare prototype use fixed hash leaves, or include dynamic split/cutover in the initial implementation? What measurable trigger and entity-size policy apply?
3. Which Datafox functions and coercion rules belong in the TypeScript golden subset, especially reference/string discrimination, lists, and string built-ins?
4. What index statistics and resource budgets are needed for a stable query plan, and which plan details should be public?
5. How should active entity materialization interact with cross-entity references and retractions while keeping all derived views replayable?
6. Does the account's current Durable Object plan and test workload fit the published limits and billing model?

## References

- [CF1] [SQLite-backed Durable Object Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [CF2] [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [CF3] [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [F1] [FokosDB package README at reviewed commit](https://github.com/lambrospetrou/fokosdb/blob/4c9d1a107bf45818685a121c881b3074d884443f/packages/fokosdb/README.md)
- [F2] [FokosShardingRuntime design/implementation record](https://github.com/lambrospetrou/fokosdb/blob/4c9d1a107bf45818685a121c881b3074d884443f/docs/agent-plans/2026-09-19-fokos-sharding-runtime.md)
- [F3] [FokosDB transaction coordinator](https://github.com/lambrospetrou/fokosdb/blob/4c9d1a107bf45818685a121c881b3074d884443f/packages/fokosdb/src/server/do-transaction-coordinator.ts)
- [P1] [`Fact`](../../crates/poneglyph/src/fact.rs), [active graph indexes](../../crates/poneglyph/src/active_graph.rs), [query adapter](../../crates/poneglyph/src/query.rs), and [local SQLite fact store](../../crates/poneglyph-local/src/facts/sqlite.rs)
- [P2] [One Piece workload description](../../README.md#benchmarks) and [`stress.rs`](../../crates/poneglyph-local/tests/stress.rs)
