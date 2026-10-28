# poneglyph.dev

Public landing page for Poneglyph: what it is, the fact/Datalog model, what you get from it, a local quickstart, and links to the public [One Piece playground](https://onepiece.poneglyph.dev) and its MCP endpoint.

- React 19 + [`@cloudflare/kumo`](https://www.npmjs.com/package/@cloudflare/kumo) components, Tailwind 4, Phosphor icons.
- Built and deployed with the `cf` CLI (`cloudflare.config.ts`). It is an assets-only Worker with no script; unknown paths serve `public/404.html` with status 404.
- Deploys to the existing `poneglyph-www` Worker on the `poneglyph.dev` custom domain, so earlier versions remain available for rollback in the Worker's version history.
- Copy lives in `src/content.ts`. Keep claims aligned with the root README and RFDs: Poneglyph is experimental, the client is not on npm, and hosted runs are smoke tests, not capacity evidence.

```sh
bun run dev      # local preview
bun run check    # typecheck + tests
CLOUDFLARE_ACCOUNT_ID=… bun run deploy
```
