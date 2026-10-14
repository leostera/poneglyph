# Deployed TODO smoke example

Private workspace package for the historical authenticated HTTP/WebSocket smoke flow. Owns its `ws` dependency. `build`, `typecheck`, `check` and `test` are offline; socket-message tests use a local event emitter, not a cloud connection.

```sh
bun run --cwd packages/example-deployed-todo-smoke check
# Only with an explicitly approved target and passphrase in the shell environment:
bun run --cwd packages/example-deployed-todo-smoke run
```

Manual `run` reads `PONEGLYPH_CLOUDFLARE_URL` and `PONEGLYPH_TODO_PASSPHRASE`. Never commit or print a real passphrase. Local checks are not hosted validation. See [RFD0004](../../docs/rfds/RFD0004-expandable-cloudflare-sharding.md#isolated-cloudflare-procedure-and-detailed-evidence).
