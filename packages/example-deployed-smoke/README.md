# Deployed smoke example

Private workspace package for the historical manual HTTP smoke flow. `build`, `typecheck`, `check` and `test` run offline; tests use fake responses and verify original identity/payload replay. They do **not** establish cloud durability or certify a deployed topology.

```sh
bun run --cwd packages/example-deployed-smoke check
# Only after explicit cloud validation authorization:
PONEGLYPH_CLOUDFLARE_URL=https://your-approved-host.poneglyph.leostera.dev bun run --cwd packages/example-deployed-smoke run
```

Do not reuse a recorded deployment blindly. See [RFD0004's resource gates](../../docs/rfds/RFD0004-expandable-cloudflare-sharding.md#isolated-cloudflare-procedure-and-detailed-evidence).
