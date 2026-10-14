# Deployed smoke example

Private workspace HTTP smoke example consuming the packaged client. `build`, `typecheck`, `check` and `test` run offline; tests verify original identity/payload replay and exact typed rows with fake responses. The target is explicit and credential-free, transport is not silently retried, and no one-root or global-clock assumption is imposed. They do **not** establish cloud durability or certify a deployed topology.

```sh
bun run --cwd packages/example-deployed-smoke check
# Only after explicit cloud validation authorization:
PONEGLYPH_CLOUDFLARE_URL=https://your-approved-host.poneglyph.leostera.dev bun run --cwd packages/example-deployed-smoke run
```

Do not reuse a recorded deployment blindly. See [RFD0004's resource gates](../../docs/rfds/RFD0004-expandable-cloudflare-sharding.md#isolated-cloudflare-procedure-and-detailed-evidence).
