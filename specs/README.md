# Small TLA+ / PlusCal models

These models are executable, deliberately small state-space checks for the two correctness-critical state machines. They are design aids, not a proof of the TypeScript implementation or of Cloudflare storage behavior. Their contract, abstraction limits, tooling pin, and validation procedure are reflected in [RFD0004](../docs/rfds/RFD0004-expandable-cloudflare-sharding.md#formal-model-and-validation).

## Models

- [`TransactionVisibility.tla`](./TransactionVisibility.tla) models two participants, a durable commit decision, independently applied participant effects, a graph `visibleSeq`, a reader that pins one snapshot, and a restarted recovery process that retries apply and publish. Invariants require that publish follows apply on every participant and that a returned cross-shard read is all-or-nothing. The model abstracts facts to the set of participants containing one transaction's effects.
- [`ShardSplit.tla`](./ShardSplit.tla) models a parent shard fenced for writes, idempotent page copying to two children, a single atomic directory epoch cutover, an old read lease, a post-cutover write, rejection of an old route, and a recovery process that replays missing copy pages. Invariants require complete child data before cutover, route/data agreement, and no parent retirement while an old lease remains.

Crashes are abstracted as interruption between atomic state-machine steps. Durable protocol state (`decision`, participant progress, copied-page progress, route epoch, and leases) survives; recovery retries are modeled as ordinary idempotent transitions. The models do **not** cover TLA+ TLC's machine state as volatile Worker memory, Byzantine faults, network duplication in detail, multiple simultaneous transactions, abort compensation, timer/lease expiry races, actual SQLite page/WAL behavior, hash-distribution quality, or liveness under Cloudflare scheduling. Those remain implementation and integration-test obligations. In particular, the split model assumes a fenced source snapshot and checks a single split; implementation must test nested splits, concurrent readers, directory lookup races, interrupted imports, and recovery against actual Durable Object storage.

## Run

Install a JDK and download a pinned TLA+ tools release (do not commit its JAR). For example, TLA+ tools 1.8.0 is available from [the upstream release](https://github.com/tlaplus/tlaplus/releases/tag/v1.8.0), SHA-256 `7beec0f04818732a62fa193731711a99aa4f11279499b2360a7d156c519ea78d` for `tla2tools.jar`.

```sh
TLA2TOOLS_JAR=/path/to/tla2tools.jar ./specs/check.sh
```

The script translates temporary copies of the PlusCal algorithms and runs TLC using the checked-in `.cfg` files. Translation output and TLC state files stay outside the repository.
