# Deployed TODO smoke example

Private workspace package for the historical authenticated HTTP/WebSocket smoke flow. Owns its `ws` dependency. `build`, `typecheck`, `check` and `test` are offline; socket-message tests use a local event emitter, not a cloud connection.

```sh
bun run --cwd examples/deployed-todo-smoke check
# Only with an explicitly approved target and passphrase in the shell environment:
bun run --cwd examples/deployed-todo-smoke run
```

Manual `run` requires an explicit, credential-free `PONEGLYPH_CLOUDFLARE_URL` and `PONEGLYPH_TODO_PASSPHRASE`. Message waiters clean up their own listeners/timers on message, error and close; admitted waits are drained during cleanup. Never commit or print a real passphrase. Local checks are not hosted validation. See [RFD0004](../../docs/rfds/RFD0004-expandable-cloudflare-sharding.md#isolated-cloudflare-procedure-and-detailed-evidence).
