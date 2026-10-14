# Sites

- Site applications belong under `sites/<hostname>/` and participate in the root Bun workspace and build/check/test gates. Keep one root `bun.lock`.
- Poneglyph remains a reusable database; applications own their HTTP/MCP surfaces. Do not add application-specific rules to canonical storage or fork its implementation.
- The playground consumes the reusable `@leostera/poneglyph-mcp` package, which owns the Agents SDK's request-local handler/tools. The site owns its dataset description, public ingress/rate limiter and the public Poneglyph client through a private service binding. Its dedicated database entrypoint assembles the unchanged canonical actors from the repository; those source imports are not a new public npm embedding contract.
- The public playground is anonymous and read-only. Enforce rate admission before MCP parsing/storage access; no caller-selected backend/graph or public write/admin/probe routes. Missing/failing rate admission must fail closed.
- Default checks are offline, including a finite native integration with tiny synthetic facts. Never trigger deployment, account lookups, a wiki/corpus load or benchmarks through build/check/test.
- Read `docs/rfds/RFD0006-public-read-only-mcp-playground.md` for the application boundary and rollout limits. A built server, advertised schema, empty response or passing fixture does not prove that the One Piece corpus was loaded.
