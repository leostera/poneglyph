# Explicit isolated write bursts

Run only when the owner has authorized cloud writes. Nothing runs from default test hooks.

```sh
bun run build:package
bun run --cwd packages/poneglyph-worker bench:write --case hot --count 1
bun run --cwd packages/poneglyph-worker bench:write --case graph --count 1
# Review both canaries before the separate load experiments:
bun run --cwd packages/poneglyph-worker bench:write --case hot --count 10000
bun run --cwd packages/poneglyph-worker bench:write --case graph --count 10000
```

Each invocation creates a fresh `write-bench-<case>-<run UUID>` graph in the existing private `poneglyph-mavplus-validation-worker` namespaces. The ephemeral authenticated preview has no public deployment target, accepts no caller-selected graph/namespace, and does not enable freshness heads or redeploy the backend. Existing `onepiece`, `control-plane-validation`, production and public-playground graphs are untouched. No resources are deleted.

- **hot:** one distinct permission assertion per transaction, all on one policy entity and field. All inputs remain independently valid; this avoids measuring stale retraction failures instead of contention. The 10,000-grant endpoint is the existing per-entity active-tuple ceiling, not a beyond-capacity experiment.
- **graph:** three selected real facts for each of 10,000 distinct pages, preferring title/category/link and falling back to namespace/text size. This is a **30,000-fact subset copy**, not 10,000 full 500-fact import batches or continuation/repair of the paused corpus. The full normalized source file must match its pinned SHA-256 before any write is sent.

One independent incoming HTTP invocation performs one native DO fetch to the backend's public transaction route with a unique stable client request token. The current runner uses direct authenticated HTTP/2 to the ephemeral preview, not Wrangler's singleton-DO local HTTP proxy. It opens up to 100 sessions with at most 100 offered write streams each; no stream is retried. Preview credentials remain in a trusted local child's memory/private IPC and the SDK's private process environment, never result files or CLI arguments. The child reuses the active pinned `cf` credential reader instead of requesting another login. This measures canonical write processing, **excluding the service entrypoint's graph-grant/RPC layer**. The private operator holds privileged bindings restricted to the existing isolated target; it is not a public API.

Exactly one burst is issued per invocation. All issued calls settle, errors/deadlines stay in caller percentiles, and no failed or uncertain write is retried. Caller concurrency means offered/unfinished independent calls—not proven simultaneous backend execution or sustained open-loop throughput. Launch span and external/native-hop timings are reported separately. Historical reports explicitly identify the older local-proxy transport; they must not be silently treated as direct-backend capacity measurements.

Read-only per-bucket audits observe retained committed/aborted/pending journals and token counts immediately and up to two minutes later; counts are not an atomic cross-bucket snapshot. Missing journals or unknown transport outcomes are not silently classified as aborted. Existing durable recovery may continue independently. Up to sixteen acknowledged operations receive exact pointed read-back checks. Burst samples are checkpointed immediately before follow-up work; audit observations are checkpointed separately. Read-back work has a shared 20-second deadline and stops on its first failure. Reports, payload hashes, versions and logs are retained under `.artifacts/write-bench/<run>/`; backend error text and response rows are not retained in reports. A fresh OS-selected local port avoids abandoned preview listeners.

For an interrupted run, `bench:write --audit-run <retained-run-UUID>` validates the retained manifest and starts an operator with writes disabled. It reads durable status only and never resends facts. A newly authorized repeat uses a fresh run/graph; it is not a retry of uncertain writes.

Architecture and evidence interpretation belong in [RFD0004](../../../../docs/rfds/RFD0004-expandable-cloudflare-sharding.md).
