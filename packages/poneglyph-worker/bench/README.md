# Isolated pointed-read benchmark

Explicit, read-only load against the existing synthetic `control-plane-validation` fixture in the isolated validation Worker. It never seeds, repairs or changes data and is not a default test/build hook. It starts an authenticated ephemeral remote preview with one native service-binding RPC per incoming HTTP request; it creates no public deployment targets, classes or Durable Object namespaces.

From `packages/poneglyph-worker`:

```sh
bun run bench:read                            # 96-call routing smoke
bun run bench:read --plan bench/scaling-plan.json  # explicit 10,000-call ramp
```

Requires Node 26, the root frozen Bun installation, working `cf` authentication, a stable 100% isolated deployment and free localhost port 8879. The runner uses the Wrangler backend pinned by the installed `cf` package. Destination account, Worker, binding identity, graph and two synthetic queries are fixed; the plan controls only counts/concurrency. Harness bounds are operational safety limits, not graph admission limits.

The benchmark stops at the first failed wave, settles every issued caller promise and never retries queries. Timeout/cancellation does not establish backend non-execution or delivery. It verifies deployment identity before/after, binds responses to a unique run ID, records actual in-flight concurrency and keeps all-outcome caller latency separate from successful hosted-caller/service latency. Closed-loop waves are not an open-loop, geographic, write-concurrent or infinite-capacity test.

Reports, verified gzip hashes and private preview logs stay in `.artifacts/read-bench/<run-id>/`. Never paste preview/authentication URLs or tokens from logs. Retain selected redacted evidence separately when recording results.

## Local read-head placement probe

```sh
bun run bench:read:local-heads               # 8,000 measured reads
bun run bench:read:local-heads --count 32    # small harness smoke
```

This separate explicit command uses **only fresh local Miniflare SQLite** and the real native RPC service; it reads no Cloudflare credentials and makes no cloud deployment, graph or namespace changes. It seeds one fixed five-fact synthetic control-plane transaction in a new temporary database, then compares canonical validation and 1/4/8 integrated metadata heads. Worker isolates restart between placements over the same local durable state so stale membership hints do not confound pool selection. Each placement warms both fixed probe queries, then measures point/16 and combined/128 waves, with actual maximum in-flight calls and whole-phase launch span recorded. A smaller `--count` may offer less than the configured concurrency. These are **eight placement/load rounds of one architecture**, not eight architectures or a demonstration of infinite capacity.

The count is 1–1250 per round (at most 10,000 measured reads). Exact typed row keys/values, complete bags and snapshot expectations are checked on every call. All issued calls settle; there are no automatic query/write retries. Raw settled measurements are checkpointed before follow-up counter diagnostics. Failures stop subsequent rounds, return failure and retain local state/original seed identity; successful runs remove only their own newly created local temporary state. Reports and hashes remain in `.artifacts/read-head-local/<run-id>/`. Caller latency includes failures/deadlines; native/service percentiles are explicitly successful-only. Per-head validation counts and canonical read-cut counts distinguish real routing from a nominal head configuration.

A local closed-loop sample cannot certify hosted CPU placement, networking, geographic p99, mixed writes, sustained/open-loop completion or unlimited membership/publication throughput. The canonical baseline may pass the same local latency target: do not attribute an apparent timing difference causally to added replicas without a controlled hosted experiment. The production/default test hooks do not run this experiment.

Architecture, protocol invariants, limitations and experiment evidence belong to [RFD0004](../../../docs/rfds/RFD0004-expandable-cloudflare-sharding.md).
