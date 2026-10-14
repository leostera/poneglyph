# Deployed benchmark example

Private package retaining the historical bounded cloud sample. `build`, `typecheck`, `check` and `test` are offline; tests use pure parameter/percentile helpers and fake write callbacks. No benchmark load is started by the workspace gates.

```sh
bun run --cwd packages/example-deployed-benchmark check
# Only after explicit approval of the target, workload and cost budget:
bun run --cwd packages/example-deployed-benchmark run
```

Named write workloads require committed replies; first failure stops new callbacks and drains admitted work. Transport is not silently retried, and no physical participant count is inferred from HTTP replies.

Manual `run` requires an explicit, credential-free `PONEGLYPH_CLOUDFLARE_URL`, `PONEGLYPH_TODO_PASSPHRASE` and bounded workload settings. This is not the canonical write-path harness or performance certification. See [RFD0004](../../docs/rfds/RFD0004-expandable-cloudflare-sharding.md#isolated-cloudflare-procedure-and-detailed-evidence) and [RFD0005](../../docs/rfds/RFD0005-write-path-experiment.md).
