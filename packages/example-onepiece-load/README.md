# One Piece load example

Private package retaining the historical local XML workload. Owns its `saxes` dependency. `build`, `typecheck`, `check` and `test` are offline; tests parse a tiny temporary XML file into a fake writer. They do not download the corpus, start a Worker or run a load benchmark.

```sh
bun run --cwd packages/example-onepiece-load check
# Only after explicit local workload authorization, with the corpus already cached:
bun run --cwd packages/example-onepiece-load run
```

Manual `run` uses the cached `tests/fixtures/cache/` corpus or `PONEGLYPH_ONEPIECE_XML`, starts the canonical package's local Worker and applies bounded batches. Exact percent-encoded titles avoid identity collisions. Uncertain delivery is not silently retried; incomplete-load persistence is retained. Hand-authored lore fixtures remain separate from the canonical benchmark corpus and independent conformance oracle. See [RFD0004's recorded workloads](../../docs/rfds/RFD0004-expandable-cloudflare-sharding.md#recorded-local-operating-workloads-2026-10-11).
