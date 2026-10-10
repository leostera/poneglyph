# `@leostera/poneglyph`

Strict TypeScript package for the Cloudflare-native Poneglyph implementation. The existing Rust workspace and local backend remain unchanged. This package is intentionally a separate runtime/library boundary and is currently an experimental `0.1.0` implementation, not a released compatibility promise.

## Current model

The domain parser accepts Rust-compatible tagged `FactValue`s, absolute URIs, non-empty `txId` batches, and stored facts with a fact ID and RFC 3339 statement time. Boundary parsers return a typed `ParseResult`; malformed external values do not enter the query model. Fact values and parsed batches are immutable. Fact assertions and retractions are still append-only inputs; the active graph is a derived projection, implemented in the storage layer milestone.

## Datalog subset

Queries are conjunctions of positive binary relations, for example:

```datalog
wiki:crew:captain(Crew, Captain),
wiki:crew:second(Crew, Second),
wiki:page:title(Crew, CrewName),
contains(CrewName, "Pirates")
```

Supported terms are uppercase-leading variables, `_` in fact relations, quoted strings, URI/string literals, and signed 64-bit integer literals. Repeated variables unify. A `FactValue::List` is exposed as one relation tuple per item, matching the current Poneglyph/Datafox bridge. Constraints are `=`, `<`, `<=`, `>`, `>=`, `eq`, `lt`, `lte`, `gt`, `gte`, `before`, `after`, `contains`, `startsWith`, and `endsWith`. Builtin variables must be bound by a positive fact relation.

The parser rejects negation, recursion/rules, non-binary relations, arbitrary expressions, unsupported builtins, unbound builtin variables, queries with no positive relation, and queries over 64 clauses or 8 KiB. There is no general-purpose optimizer: positive fact relations run in source order as a streaming nested-loop join; constraints run after relation binding. Callers can bound emitted results (`maxResults`, default 10,000), and `AbortSignal` cancellation propagates through the async source. The evaluator does not materialize the complete result set.

`FactSource.scan` receives an exact `field` plus optional bound `entity` and/or `value`. These correspond to the field, field+entity, field+value, and field+entity+value lookup shapes. Entity routing and the local indexes for those lookups are implemented in later milestones; this initial evaluator contract makes scan pushdown explicit.

## Local checks

Requires Node.js and pnpm. The Cloudflare Vitest plugin runs tests in the local Workers runtime; no Cloudflare account resources are needed.

```sh
cd cloudflare
pnpm install
pnpm check
```
