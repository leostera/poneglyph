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

Architecture, protocol invariants, limitations and experiment evidence belong to [RFD0004](../../../docs/rfds/RFD0004-expandable-cloudflare-sharding.md).
