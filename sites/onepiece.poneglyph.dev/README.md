# One Piece playground

Developer-facing browser playground and read-only MCP endpoint for Poneglyph at `https://onepiece.poneglyph.dev`, built with React and [Kumo](https://kumo-ui.com). The site is public: no sign-in is required, and every route is rate limited per IP. It is an application of Poneglyph (see [RFD0006](../../docs/rfds/RFD0006-public-read-only-mcp-playground.md)), not a separate database.

- **Query**: curated and free-form Datalog over the `onepiece-wiki` graph, with per-query latency (browser round trip, Worker, database, snapshot/evaluate/release phases) plus shard requests, leases, tuples and bytes read. A session panel keeps p50/p95/max and a sparkline.
- **Write facts**: assert or retract up to 25 typed facts per atomic transaction. The server assigns `source = playground:author:anonymous` and an idempotent request token; storage 4xx is reported as rejected, anything else as unknown delivery (retry with the same token).
- **Schema**: observed fields and value tags at one snapshot.
- **Connect an agent**: MCP config for `/mcp` (tools `describe_dataset`, `get_schema`, `query`; read-only).

## Boundaries

- `/api/*` is anonymous but requires same-origin JSON, bounded bodies, and rate limits keyed by edge IP before parsing (API 120/min, writes 20/min). Missing limiters or bindings fail closed.
- `PONEGLYPH` (`playground`) is read-only; `PONEGLYPH_WRITER` (`playground-writer`) has read/write on `onepiece-wiki` only. MCP uses the read-only binding. Grants live in `packages/poneglyph-worker/cloudflare.config.ts`.
- The loader principal `playground-loader` is used only by the loopback operator (`bun run dev:seed`, port 8878) and is not part of the public Worker.

## Data

`onepiece-wiki` holds the full pinned One Piece wiki corpus (`.artifacts/import/pages10` + `remainder90`, 1,530,195 facts / 296,624 page records) plus the v5 semantic overlay (35,986 facts: characters, crews, captains, ships, bounties). `bun run load:corpus -- plan|run|status` loads overlay first, then base batches, verifying every payload SHA-256, journaling to `.artifacts/import/onepiece-wiki/`, replaying unknown outcomes with the same transaction ID, and stopping on unexpected 4xx. Demo writes land in the same graph under the `playground:` source prefix and never overwrite corpus facts.

## Development

```sh
bun install --frozen-lockfile && bun run build:package   # repository root
bun run --cwd sites/onepiece.poneglyph.dev check          # typecheck + offline tests
bun run --cwd sites/onepiece.poneglyph.dev build
bun run --cwd sites/onepiece.poneglyph.dev preview:local  # offline UI on 127.0.0.1:8790 with overlay + 40 base batches
```

Tests run against real canonical SQLite actors in Miniflare with fixture facts; no cloud resources. `bun run deploy` deploys the private service before the public Worker. Hosted loads, deploys and Access changes are explicit operator actions.

## Query inventory and read-path rubric

`describe_dataset` publishes `queryInventory` from `src/query-rubric.ts`: relation binding forms and wildcard terms; supported typed comparison/string builtins; conjunction, joins and bag semantics; physical-operator boundaries; unsupported forms; and query budgets. It does not publish a static predicate inventory. `get_schema` reads active fields and root FactValue tags at its declared subtree-vector snapshot; it is not a constraint schema or proof that a corpus load is complete. The generic engine still accepts any valid predicate URI, and an absent field is not a schema violation.

The deterministic cohort contains 50 unique queries generated from the receipt-verified 227,692-page / 1,096,908-fact base prefix: five full constant bindings (one per field), 20 entity-bound relations across all five fields, 20 value-bound relations over selective title/category/link/text-byte values, and five conjunction/builtin join shapes. Namespace is covered by its full and entity-bound forms; value `0` is deliberately not used because its expected broad result exceeds the row budget. The runner accepts 50 requests (one pass) or 100 requests (the same 50 queries twice, with distinct evidence keys) to retain a strict per-invocation budget; this increases repeat samples, not unique-query coverage. The 10,000-query target therefore means 200 reviewed 50-request passes or 100 reviewed 100-request batches over this initial cohort, not 10,000 distinct query strings. Unbound full-relation and wildcard scans remain excluded from hosted reads because they risk query budgets. Before the hosted command, run the local planner to verify the corpus hash, exact committed receipt prefix and expected typed result digests without accessing credentials or the network:

```sh
bun run --cwd sites/onepiece.poneglyph.dev benchmark:query-rubric
```

For end-to-end local correctness, build the canonical Worker bundle if needed, then use `--local`. This starts an isolated Miniflare runtime with a fresh temporary SQLite Durable Object persistence path, replays the exact 2,208-batch receipt-verified prefix (227,692 pages / 1,096,908 facts) with fresh local-only request tokens and server-minted transaction IDs, and compares every query to an independent typed-multiset oracle. It reads no Cloudflare credentials, sends no external requests, and never touches the hosted graph. The temporary database is removed after a completed batch; interrupted runs retain it for diagnosis and do not retry queries. This is a check of the defined 50-query cohort, not every valid Datalog program or a hosted performance test:

```sh
bun run --cwd packages/poneglyph build
bun run --cwd sites/onepiece.poneglyph.dev benchmark:query-rubric -- --local --count 50
# Or run the same 50 unique cases twice:
bun run --cwd sites/onepiece.poneglyph.dev benchmark:query-rubric -- --local --count 100
```

A 100-request local run matched all 100 complete typed multisets (50 unique queries, each run twice). Per-run JSON output is generated locally under the git-ignored `evidence/` directory; local timings are for the isolated SQLite runtime and must not be compared as hosted latency. The following is a separate, explicitly hosted, read-only command. It sends one serial query per case, spaces request starts by at least 2.2 seconds to remain under the configured approximate 30/minute MCP allowance, compares every answer to an independently evaluated typed multiset, and writes per-case latency/lease/shard metrics plus result hashes to a new non-overwriting evidence file. Each failure is retained without raw response bodies or automatic query retry; later cases still run. It does not write graph facts, alter sampling, or deploy:

```sh
bun run --cwd sites/onepiece.poneglyph.dev benchmark:query-rubric -- --hosted --confirm-read-only-hosted --count 50
# Or run the same 50 unique cases twice (100 serial requests):
bun run --cwd sites/onepiece.poneglyph.dev benchmark:query-rubric -- --hosted --confirm-read-only-hosted --count 100
```

The runner uses the local Access-cookie helper without printing or persisting its credential. A batch with any backend error or result mismatch is not a passing compliance run. Report successful bounded samples only as descriptive evidence, not a capacity or tail-latency claim. Benchmark commands are never a build/check/test side effect; expand to a later batch only after reviewing the previous evidence and bottlenecks.

The value-bound access path seeks the existing `value_key` index, then applies exact typed-value checks; unbound-entity reads still fan out across the full owner vector. Earlier hosted batches included backend failures; a separate repeat batch matched all 50 cases, and a 100-request repeat matched all 100 attempts across the same 50 unique queries. Results and limitations are summarized in [RFD0006](../../docs/rfds/RFD0006-public-read-only-mcp-playground.md). Per-run JSON is git-ignored, and the runner does not automatically retry queries.
