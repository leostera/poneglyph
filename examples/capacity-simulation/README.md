# Capacity simulation example

Private workspace example. Uses canonical routing/accounting helpers to simulate logical storage; it writes **zero payload rows** and does not prove physical capacity.

From the repository root:

```sh
bun run check
bun run build
bun run --cwd examples/capacity-simulation run 1000000 16
```

This package has independent `build`, `typecheck`, `check` and offline `test` scripts. See [RFD0004](../../docs/rfds/RFD0004-expandable-cloudflare-sharding.md#local-operating-and-review-gates).
