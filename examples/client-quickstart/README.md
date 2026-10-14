# Client quickstart example

Private workspace example consuming `@leostera/poneglyph`'s built exports. Writes three related facts under a stable caller identity and queries a three-relation join.

From the repository root:

```sh
bun run check
bun run build
# Start the local Worker separately with bun run dev, then use its actual URL:
PONEGLYPH_URL=http://127.0.0.1:5173 bun run --cwd examples/client-quickstart run
```

`build`, `typecheck`, `check` and `test` are part of the workspace gates. Tests use an injected fake transport; only `run` contacts the configured endpoint. See [RFD0004](../../docs/rfds/RFD0004-expandable-cloudflare-sharding.md#local-operating-and-review-gates).
