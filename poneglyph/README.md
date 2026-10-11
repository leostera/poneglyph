# `@leostera/poneglyph`

Experimental TypeScript primitives for Poneglyph: typed graph facts, URI and value parsing, and a bounded Datalog query parser/evaluator. The package targets JavaScript runtimes and Cloudflare Workers. It is version `0.1.0` and does not promise a stable compatibility surface.

> This npm package currently publishes the portable fact/query core. The repository's SQLite Durable Object storage runtime is still an experimental Worker prototype, not yet a supported embeddable API from this package.

## Install

```sh
npm install @leostera/poneglyph
```

## Parse facts and a query

```ts
import { parseFactBatch, parseDatalogQuery } from "@leostera/poneglyph";

const batch = parseFactBatch({
  txId: "release:seed-001",
  facts: [
    {
      source: "agent:release-assistant",
      entity: "app:service:auth-api",
      field: "app:service:blocked-by",
      value: { type: "reference", value: "app:task:rotate-key" },
      retraction: false,
    },
    {
      source: "agent:release-assistant",
      entity: "app:task:rotate-key",
      field: "app:task:status",
      value: { type: "text", value: "open" },
      retraction: false,
    },
  ],
});
if (!batch.ok) throw new Error(batch.error.message);

const query = parseDatalogQuery(
  'app:service:blocked-by(Service, Task), app:task:status(Task, "open")',
);
if (!query.ok) throw new Error(query.error.message);
```

`parseFactBatch` and `parseDatalogQuery` return typed `ParseResult` values; malformed input is reported as data instead of being silently coerced. The package also exports the fact/value/identifier types, Datalog AST, `FactSource` interface, and evaluator. Query syntax is intentionally bounded to positive binary relations and supported pure constraints; it is not general SQL or recursive Datalog.

## Build and publish

The package name is scoped because the unscoped npm name `poneglyph` is already taken. `publishConfig.access` is set to `public`; `prepublishOnly` runs the local package checks and `prepack` builds ESM JavaScript and TypeScript declarations into `dist/` before packing.

```sh
cd poneglyph
pnpm install
pnpm run build:package
npm pack --dry-run
npm publish --access public
```

Publishing requires an npm account authorized for the `@leostera` scope and a fresh version in `package.json`. This repository currently has no `LICENSE` file or license metadata; choose and add the intended license before publishing a public package. Do not publish until the license and the package's limited public API are intentional.

The full application prototype, local development, Cloudflare deployment and cleanup guide, and bounded validation evidence remain in the repository's `poneglyph/OPERATIONS.md`. Detailed storage design and model-check limits are recorded in `docs/rfds/RFD0004-expandable-cloudflare-sharding.md`.
