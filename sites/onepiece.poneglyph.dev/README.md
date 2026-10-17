# One Piece MCP playground

Tiny read-only MCP application, protected by Cloudflare Access for members of the owner's personal Cloudflare account. Its entrypoint composes `createPublicPoneglyphMcpWorker` with dataset guidance, IP-rate admission and a private `PONEGLYPH` RPC binding. There is no query editor, hosted chat model or separate database API key.

```ts
using graph = await env.PONEGLYPH.getGraph({ graphId: "onepiece" });
```

The reusable MCP package manages that graph's per-tool lifetime. The private `packages/poneglyph-worker` service enforces the playground principal's read-only graph grant; writes are denied independently of the MCP tool list. No database actors/HTTP client adapter live in this site.

The current hostname is `onepiece.poneglyph.dev`. The playground and private service were freshly redeployed with routing version 9 and unversioned Worker names. The graph has six active synthetic smoke-test facts and no imported wiki-corpus facts. The previous load-test dataset and its receipts/query evidence are historical only; they were not migrated or copied. Imports remain paused. [RFD0006](../../docs/rfds/RFD0006-public-read-only-mcp-playground.md) records deployment state and limitations.

## Offline development

```sh
# Repository root:
bun install --frozen-lockfile
bun run build:package
bun run --cwd sites/playground.poneglyph.leostera.dev check
bun run --cwd sites/playground.poneglyph.leostera.dev build
```

Root build/check/test includes the service, adapter and site. Node hosts native tests against real canonical SQLite actors with six synthetic facts, not cloud resources/corpus data. `dev` uses the referenced service locally with ignored persistence. `dev:seed` is an explicit authenticated remote operator mode, pinned to `127.0.0.1:8878`; it never runs in default gates. Verify the owned listener before calling it. `/seed` submits only the fixed manifest in `src/test-facts.ts`; `/verify` executes three fixed private reads. Neither is part of the public deployment.

`bun run deploy` builds dependencies and deploys the central private service before the public Worker. A new service means fresh namespaces, not automatic migration; never mistake seeding a distinct service for reconciliation against the old database. Keep uncertain original IDs/payloads and stop instead of silently retrying. Deployment/full corpus ingestion/deletion remain explicit operations requiring authorization.

## Approved bounded import

`POST /import` is the only write-route exception. It requires runtime-verified Access for the existing account-member app; client-supplied Access headers do not authenticate. A separate `PONEGLYPH_IMPORT` binding uses the `playground-importer` principal. MCP keeps the original read-only binding and two read-only tools. Browser Origins and OPTIONS are rejected, without public authentication exceptions.

The immutable `src/import-plan.json` records the completed first 10% segment. A distinct versioned `src/import-plan-remainder90.json` admits only the exact SHA-256-pinned remainder payloads under `.artifacts/import/remainder90/`; it does not overwrite the first plan or reuse transaction IDs. Its 2,669 batches total 394,201,767 serialized payload bytes and expire within two days. Source provenance is `wiki:onepiece:dump:<XML SHA-256>`, not the historical normalized file's fixture label. All namespaces and repeated page records are retained; whole pages stay together in batches of at most 500 facts/800,000 bytes. Canonical write/participant/accounting limits are unchanged. Approximate import admission is separate: namespace 2026101403, 60/minute per edge IP/location, not a financial cap.

`bun run import:prepare:remainder` is an explicit offline command that verifies the full normalized file hash/counts and creates a new non-overwriting segment plan. `bun run import:audit:remainder` independently compares every pinned payload fact and page boundary against the normalized corpus. Run `bun run import:run:remainder -- --max-batches=200` as a bounded hosted segment through the existing Cloudflare login; it stops only after the configured number of acknowledged batches and resumes from the durable journal. It fsyncs original identities before dispatch and complete receipts after acknowledgment, and uses serial backpressure. It never resends an unknown request; the one pinned retry for ordinal 827 became eligible only after same-ID reconciliation recorded the original as aborted. Uncertain delivery stops the load; retain the exact batch and reconcile that original ID/service/graph within retention. Successful receipts do not themselves verify every projected query answer. Default gates never invoke any import command.

## Connecting an agent

```text
https://onepiece.poneglyph.dev/mcp
```

Sign in using a Cloudflare account that is a member of the owner's personal account. The Worker-scoped Access app uses only the Cloudflare IdP and an explicit Cloudflare Account Member selector; email-PIN login, email allowlists, Everyone and service-token grants are excluded. Workers.dev and preview URLs remain disabled. Your MCP transport must support Access authentication; browser sign-in alone does not authenticate a separate agent process. Call `describe_dataset` for syntax and limitations, then `get_schema` for fields observed at a declared snapshot; fixture data is not verified wiki lore. MCP POSTs have an approximate **30/minute per-IP, per-Cloudflare-location** allowance; `429` includes `Retry-After: 60`. Shared IPs share allowance. Native query budgets remain unchanged, and errors never become truncated successes. The generic handler's wildcard CORS is not an Access exemption or a promise of cross-origin cookie authentication. Local native tests bypass the cloud Access edge; deployment verification must read back the policy and check unauthenticated ingress separately.

## Query inventory and read-path rubric

`describe_dataset` publishes `queryInventory` from `src/query-rubric.ts`: relation binding forms and wildcard terms; supported typed comparison/string builtins; conjunction, joins and bag semantics; physical-operator boundaries; unsupported forms; and query budgets. It does not publish a static predicate inventory. `get_schema` reads active fields and root FactValue tags at its declared subtree-vector snapshot; it is not a constraint schema or proof that a corpus load is complete. The generic engine still accepts any valid predicate URI, and an absent field is not a schema violation.

The deterministic cohort contains 50 unique queries generated from the receipt-verified 227,692-page / 1,096,908-fact base prefix: five full constant bindings (one per field), 20 entity-bound relations across all five fields, 20 value-bound relations over selective title/category/link/text-byte values, and five conjunction/builtin join shapes. Namespace is covered by its full and entity-bound forms; value `0` is deliberately not used because its expected broad result exceeds the row budget. The runner accepts 50 requests (one pass) or 100 requests (the same 50 queries twice, with distinct evidence keys) to retain a strict per-invocation budget; this increases repeat samples, not unique-query coverage. The 10,000-query target therefore means 200 reviewed 50-request passes or 100 reviewed 100-request batches over this initial cohort, not 10,000 distinct query strings. Unbound full-relation and wildcard scans remain excluded from hosted reads because they risk query budgets. Before the hosted command, run the local planner to verify the corpus hash, exact committed receipt prefix and expected typed result digests without accessing credentials or the network:

```sh
bun run --cwd sites/playground.poneglyph.leostera.dev benchmark:query-rubric
```

For end-to-end local correctness, build the canonical Worker bundle if needed, then use `--local`. This starts an isolated Miniflare runtime with a fresh temporary SQLite Durable Object persistence path, replays the exact 2,208-batch receipt-verified prefix (227,692 pages / 1,096,908 facts) with fresh local-only request tokens and server-minted transaction IDs, and compares every query to an independent typed-multiset oracle. It reads no Cloudflare credentials, sends no external requests, and never touches the hosted graph. The temporary database is removed after a completed batch; interrupted runs retain it for diagnosis and do not retry queries. This is a check of the defined 50-query cohort, not every valid Datalog program or a hosted performance test:

```sh
bun run --cwd packages/poneglyph build
bun run --cwd sites/playground.poneglyph.leostera.dev benchmark:query-rubric -- --local --count 50
# Or run the same 50 unique cases twice:
bun run --cwd sites/playground.poneglyph.leostera.dev benchmark:query-rubric -- --local --count 100
```

A 100-request local run matched all 100 complete typed multisets (50 unique queries, each run twice). Per-run JSON output is generated locally under the git-ignored `evidence/` directory; local timings are for the isolated SQLite runtime and must not be compared as hosted latency. The following is a separate, explicitly hosted, read-only command. It sends one serial query per case, spaces request starts by at least 2.2 seconds to remain under the configured approximate 30/minute MCP allowance, compares every answer to an independently evaluated typed multiset, and writes per-case latency/lease/shard metrics plus result hashes to a new non-overwriting evidence file. Each failure is retained without raw response bodies or automatic query retry; later cases still run. It does not write graph facts, alter sampling, or deploy:

```sh
bun run --cwd sites/playground.poneglyph.leostera.dev benchmark:query-rubric -- --hosted --confirm-read-only-hosted --count 50
# Or run the same 50 unique cases twice (100 serial requests):
bun run --cwd sites/playground.poneglyph.leostera.dev benchmark:query-rubric -- --hosted --confirm-read-only-hosted --count 100
```

The runner uses the local Access-cookie helper without printing or persisting its credential. A batch with any backend error or result mismatch is not a passing compliance run. Report successful bounded samples only as descriptive evidence, not a capacity or tail-latency claim. Benchmark commands are never a build/check/test side effect; expand to a later batch only after reviewing the previous evidence and bottlenecks.

The value-bound access path seeks the existing `value_key` index, then applies exact typed-value checks; unbound-entity reads still fan out across the full owner vector. Earlier hosted batches included backend failures; a separate repeat batch matched all 50 cases, and a 100-request repeat matched all 100 attempts across the same 50 unique queries. Results and limitations are summarized in [RFD0006](../../docs/rfds/RFD0006-public-read-only-mcp-playground.md). Per-run JSON is git-ignored, and the runner does not automatically retry queries.
