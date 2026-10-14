# RFD0006: Public Read-Only MCP Playground

## Status

Implemented prototype and initial bounded deployment (2026-10-14), at the user's explicit request: Agents SDK, public anonymous rate-limited MCP, six synthetic facts, then a generic private RPC service and tiny playground composition. The initial dedicated database/public Worker deployed from `3592158`; its seed committed at `6c000bb`. The central-service cutover is recorded separately below when performed. Public MCP confirmation from this machine is blocked by its work-network Cloudflare Gateway DNS classification, not verified as successful. No complete One Piece corpus load is recorded. Canonical storage's bounded correctness/performance evidence remains in [RFD0005](./RFD0005-write-path-experiment.md); it does not establish universal correctness or hosted performance.

## Current deployment: Cloudflare-account members only (2026-10-14)

The user changed this site's access policy and chose `https://onepiece.poneglyph.dev/mcp`. This section supersedes historical anonymous/no-login deployment requirements below; the reusable MCP package remains generic. The current site configuration deploys this exact hostname and its runtime allowlist accepts it plus loopback development hosts. The old public hostname is not an alternate runtime entrypoint in this latest configuration.

Access application `17e9e6e4-edf9-4fdc-bead-b8575669dcb4` protects the receiving playground Worker identity `6df1a5832f6a44129e5986f60898054c`, so associated routes/hostnames are covered. Its single reusable Allow policy uses `cloudflare_account_member` scoped explicitly to the owner's personal account. The only allowed IdP is the existing Cloudflare login provider, with direct redirection and a one-hour session. Email one-time PIN login, email/domain allowlists, Everyone, bypass, service-token grants and public-path overrides are excluded. OPTIONS authentication is not bypassed. Workers.dev and preview URLs stay disabled. Other Access apps/IdPs and corporate Gateway policies are not changed.

The homepage/schema disclose authentication. A separate MCP process must use an Access-compatible authenticated transport; browser login alone is insufficient. No MCP OAuth authorization server is added. Generic wildcard CORS is not an Access bypass or a cross-origin credential compatibility claim.

An isolated earlier hostname-only deployment (`fb59f37`, version `5b96cf17-1111-4fb9-8e4e-0322ba6c6ad6`) was superseded 16 seconds later by another `cf_cli` deployment (`195b8474-58df-4d55-9ad8-9f9e76ce4cb1`), which changed the service binding and removed the new hostname. That failed preservation assertion and DNS `ENOTFOUND` remain evidence, not a successful MCP connection. The user then explicitly authorized checking and redeploying the latest source. Current source, built manifest and native modern/legacy query tests agree on `onepiece.poneglyph.dev`; hostile suffixes and the obsolete hostname are rejected. Root offline check/build passes **213 tests**, with one opt-in benchmark skipped. This revalidation is not a full conformance tier or corpus certification.

Redeploy only the receiving playground Worker for the hostname repair, preserving the currently configured `poneglyph-service-worker` binding, read-only principal and limiter. Do not invoke the composite deploy script, redeploy/reseed the database, delete the old database or run a corpus load as part of this repair. Preflight already observed a newer deployed version (`a1f8caa5-f630-4e3b-86fc-2e9e5287cd63`) and restored domain before this repair upload; final API/probe evidence must identify the exact version actually observed. Local Miniflare bypasses Access. A policy read-back and anonymous login redirect do not prove authenticated login, denial of another authenticated identity, or successful hosted MCP queries.

The playground-only redeploy from `17f5d47` succeeded as version `9644b38a-ce2e-462d-b36f-1265a7c65e47`. Final authenticated API inspection confirmed the exact domain, DNS record, unchanged service/limiter bindings, disabled workers.dev/preview URLs and the unchanged account-member policy/Cloudflare-only IdP. Credential-free evidence is retained at [`2026-10-14-onepiece-domain-redeploy.json`](../../sites/playground.poneglyph.leostera.dev/evidence/2026-10-14-onepiece-domain-redeploy.json). The configured local DNS resolver returns Cloudflare addresses for the hostname, but macOS system lookup, Node fetch and curl still return `ENOTFOUND`, even after an unprivileged local cache flush. The reason for that resolver discrepancy is not established. No alternate resolver, forced-IP request, corporate policy modification or privileged resolver restart was used. Anonymous Access redirects and authenticated MCP calls therefore remain unverified from this environment; successful deployment/control-plane inspection is not an end-to-end connection.

## Access-protected corpus import amendments (2026-10-14)

The user first authorized adding `/import` and loading 10% of the corpus, and later explicitly requested finishing the corpus import and rerunning the category/title performance queries against the larger dataset. The follow-on authorization covers only the fixed remaining 90% defined below; it does not authorize arbitrary writes, old-resource deletion, publication, unrelated large workloads or broader benchmark loops. MCP remains read-only and canonical storage is unchanged.

Subsequent authenticated `cloudflared access curl` requests successfully initialized MCP, described the schema and ran Luffy title/category/link queries. All three returned empty complete answers at snapshot 0. This establishes authenticated transport to the new private service, not corpus population. The earlier DNS/installation failures above remain historical evidence. Raw curl/generic MCP installation does not inherit cloudflared's cached Access login.

### Selection and provenance

Use the deterministic prefix of **29,662 of 296,624 normalized XML pages**, rounded down, without namespace filtering. Retain every normalized fact belonging to each selected page: **204,183 of 1,530,195 facts** (page fraction, not fact fraction). No supplemental lore, fabricated relationships or full text. Verify the normalized file SHA-256 `e09d65047fe1479eacc7823761526d8280e3071d5c805ddf4b9bef43acb29064` and full page/fact counts before dispatch. Its recorded source XML SHA-256 is `1446ff8fca4bdebd289e5a546d67078d1170369fb3bfb65a35c758d53cd4e084`. The raw normalized file retains its historical `fixture:onepiece-fandom` label; imported facts use `wiki:onepiece:dump:<XML hash>` so their provenance is distinct from synthetic fixtures. Values, exact title-derived identity and extraction limits are unchanged.

The audit found one repeated title identity (`Blog:Recent posts`, positions 120,738 and 293,949), outside the chosen prefix. Count pages by title records, not unique entities; no duplicate identities occur in this slice. Preserve this finding rather than deduplicating the corpus or claiming universal identity uniqueness. An initial offline preparation rejected that out-of-slice duplicate; no hosted write occurred in that failed preparation.

The immutable approved first segment is [`src/import-plan.json`](../../sites/playground.poneglyph.leostera.dev/src/import-plan.json). Whole pages stay together in **413** batches, at most **500 facts** and **800,000 actual UTF-8 bytes** each (observed maximum 170,764 bytes; total payload 51,415,460 bytes). Original transaction IDs include the full normalized corpus digest, `pages10`, and the fixed batch ordinal. Each approved body has its own SHA-256. That segment completed with 413 acknowledged batches and twenty independent exact typed multiset reads at snapshot 404; see [`2026-10-14-onepiece-import-10pct.json`](../../sites/playground.poneglyph.leostera.dev/evidence/2026-10-14-onepiece-import-10pct.json). This proves only the recorded witnesses, not full-corpus correctness.

At the user's follow-on request, the deterministic complement is **266,962 of 296,624 page records**, containing **1,326,012 facts**. Its separate, versioned plan is [`src/import-plan-remainder90.json`](../../sites/playground.poneglyph.leostera.dev/src/import-plan-remainder90.json), with distinct `remainder90` transaction IDs, per-body hashes, a two-day window, **2,669** whole-page batches, maximum 500 facts/800,000 bytes (observed maximum 190,839 bytes), and **394,201,767 serialized payload bytes**. The explicit offline audit compared every batch's ordered typed facts/page boundaries against the pinned normalized corpus and passed. The receiving Worker is deployed with this plan (version `aa68ed98-1cd8-4aef-aeb3-70cff0e0ab52`) and the bounded uploader is active. At the durable journal checkpoint observed 2026-10-14 20:15:13 UTC, batches 0–668 were acknowledged: **669 / 2,669 batches, 332,936 remainder facts and 80,703 remainder page records**; batch 669 had an in-flight record. This is a moving checkpoint, not completion. The ignored durable journal is authoritative; an in-flight/unknown outcome must be reconciled against its original transaction ID and payload before dispatch resumes. The full-corpus run is not complete until all exact receipts and the resulting independent query witnesses are separately verified.

The remainder contains the known repeated `Blog:Recent posts` title identity at positions 120,738 and 293,949, with differing namespace metadata. Preserve both records and their source facts; do not deduplicate, skip or claim entity-title identities are universally unique. Existing 1,000-fact/1-MB/32-participant/100-SQL-binding limits and index/accounting/projection/publication/release semantics remain enforced by the unchanged database. A rejection must stop, not trigger rebatching, skipping or reduced indices.

### Ingress and capability boundary

Only `POST https://onepiece.poneglyph.dev/import`, without URL query parameters or browser Origin, is supported. The receiving Worker requires the runtime's verified `ctx.access` for the existing Access app audience and an authenticated user identity. Never trust caller-supplied JWT/email headers. The existing Worker-scoped account-member policy and Cloudflare-only IdP remain unchanged; no service-token grant, email allowlist, bypass, public exception or OPTIONS authentication exemption is added. The platform documents [verified Access context](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#read-authenticated-user-identity-with-ctxaccess), including that it does not propagate through RPC/service bindings and cannot reach user code behind a static-assets router. This deployment must have no static-assets router.

A separate `PONEGLYPH_IMPORT` binding has deployment-owned `props.clientId = "playground-importer"`, granted read/write only on `onepiece`. `PONEGLYPH` retains its read-only principal; generic MCP/storage/service mechanisms remain application-independent. Only the site route selects the writer, after admission, byte bounding, exact approved-body digest and canonical fact parsing. Unknown payloads/IDs/ordinals/graphs, retractions and extra arguments never acquire a graph. This is not a general administration/import API.

The separate native limiter (namespace **2026101403**, **60/minute** per edge IP/location) fails closed and precedes body parsing/storage. Verify namespace collisions before deployment. It is approximate abuse admission, not exact spend accounting. Reject oversized streamed bytes even without trustworthy Content-Length. Responses have no-store and no write CORS. The plan closes two days after preparation, within the configured seven-day terminal-identity horizon; closure does not refresh IDs or imply a guarantee beyond canonical retention/capacity rules.

### Operator lifecycle and evidence

Preparation, audit, upload and reconciliation are explicit application operator commands, never default gate hooks. Retain separate `.artifacts/import/pages10/` and `.artifacts/import/remainder90/` manifests, exact payloads, and durable journals with exact service/graph/transaction/payload identities. Use bounded uploader segments that stop only at acknowledged-batch boundaries (for example 200 batches per invocation), so controller timeouts do not kill an in-flight request. Use `cloudflared access curl` without exposing tokens, login URLs, cookies or raw response headers. Fsync an in-flight record **before sending** and a validated committed receipt after the canonical write fully applies/publishes/releases. Upload sequentially with backpressure. No timeout/disconnect/5xx/malformed reply implies abort; stop without automatic retry or a replacement ID and reconcile that exact original batch explicitly. Interrupted or unknown delivery must not be labelled completed.

Deployment preflight must verify the current versions, Access destination/policy, private service namespaces/grants and graph state. Add the importer grant to the existing private service without recreating or renaming its actors; deploy producer before the receiving Worker. Check for an intervening deployment before each upload. Keep old dedicated fixture resources untouched.

Offline tests cover audience/runtime identity, forged headers, host/method/Origin denial, closed window, immutable plan/digest/counts, streamed byte limits, fail-closed admission, disposal and unknown failure/no retry. Native SQLite/RPC integration substitutes only a two-fact approved fixture plan at bundle time: direct service invocation receives no Access context, simulated HTTP Access permits the import, original-ID replay returns the same receipt, MCP exposes only the two read tools and reads exact tagged text/int64 results. Simulation is not evidence of hosted nonmember denial or production policy enforcement.

All-batch acknowledgments and finite independent exact unordered typed multiset reads are separate evidence layers. Neither certifies every projection, physical capacity, hosted throughput, full canonical conformance or universal correctness. Static dataset guidance must distinguish the verified 10% from the remainder plan until the latter's complete receipts and independent query witnesses are recorded. Do not infer completed ingestion from a prepared or deployed plan.

## Semantic identity, enrichment and observed schema direction (2026-10-14)

The user requested a separate semantic layer over the downloaded wiki records. Base facts and their exact title-based page identities remain unchanged. Semantic entities use opaque, kind-scoped graph URIs such as `onepiece:crew:<UUID>`; names, aliases and source-page links are ordinary facts, not identity material. A deterministic UUIDv5 may be seeded from the One Piece wiki's canonical MediaWiki page ID and entity kind, so title/label edits do not change the graph URI. Page IDs are source locators only and must not appear as the semantic graph identity.

Resolving redirects and aliases is a separate, reviewable identity step. A redirect may resolve to the canonical source page ID; distinct source pages that represent the same crew/person/ship require an explicit identity-map decision. Do not fuzzy-match titles, infer equivalence from similar spellings, or use an opaque UID as a substitute for entity resolution. Derived relationship values reference semantic UIDs; source-page references and versioned extraction provenance preserve why each claim exists. Keep explicit template/category evidence separate from any inferred or human-curated narrative relation. Ordinary wiki links in prose do not imply `knows`, membership or allegiance.

The local extraction pipeline is being developed while the bounded base import runs. It must produce deterministic, reviewable output and an audit report for unresolved links, collisions, duplicate claims and unsupported evidence. It must not write to the hosted graph. Any enrichment import needs its own exact pinned plan, identity/payload digests, operator review and separate authorization; the current remainder authorization does not include it.

Replace static predicate inventories in the MCP surface with `get_schema`, a read-only observation of fields and value tags actually present in the graph at a declared read snapshot, plus observed entity-kind facts when available. It describes stored facts; it does not assert universal domains/ranges, required fields or write enforcement. `define_schema`, schema labels, constraints and any validation/enforcement remain a separate future design and capability. The current Datalog evaluator is non-recursive, so multi-hop questions need bounded traversal or a separately reviewed path capability.

The first implementation step adds a tested, deterministic page-ID-to-opaque-URI primitive in [`packages/write-path-bench/onepiece-identities.ts`](../../packages/write-path-bench/onepiece-identities.ts). This is not yet the extraction pipeline, redirect/alias registry, `get_schema` tool, or evidence of any additional hosted facts.

## Summary

Build a tiny agent-facing application under [`sites/playground.poneglyph.leostera.dev`](../../sites/playground.poneglyph.leostera.dev/). Its public Worker serves connection instructions at `/` and stateless MCP at `/mcp`, using `createMcpHandler` from `agents/mcp/server`. Agents learn the wiki graph schema through `describe_dataset`, then send bounded Datalog through `query`. The application reads one fixed graph via the public Poneglyph client and a private service binding. A separate, non-public Worker assembles the unchanged canonical database actors. The public Worker has no write/admin/probe endpoints. Cloudflare's native rate-limiting binding admits approximately 30 MCP POSTs/minute per edge IP per location, with explicit fail-closed admission.

## Current direction: generic private RPC service (2026-10-14)

The user selected `env.PONEGLYPH.getGraph({ graphId: "onepiece" })` as the Worker-consumer API. [`packages/poneglyph-worker`](../../packages/poneglyph-worker/) assembles the unchanged canonical actors and a private `WorkerEntrypoint`. It has no public domain, workers.dev/preview URL, HTTP database endpoint, probe or admin route. `poneglyph.svc.leostera.dev` is a logical service label, not a publicly registered custom domain. Calls use the named service binding, not DNS.

```ts
using graph = await env.PONEGLYPH.getGraph({ graphId: "onepiece" });
const answer = await graph.query(datalog);
// A separately granted writer may do this; readers are denied server-side:
await graph.transact(facts, { txId: "app:original-operation" });
```

### Identity, policy and capabilities

Binding configuration supplies `props: { clientId }`. The receiving service parses `this.ctx.props` and the exact `{ graphId }` request before storage. Missing/malformed identity, unknown principal, malformed policy, ungranted graph or caller-supplied identity/permissions/backend fields deny access. Cloudflare documents that setting these props requires permission to edit/deploy the receiving Worker; deployment administrators are trusted authorities, not adversaries isolated by this scheme. Props are an authenticated deployment assertion, **not automatically discovered caller script identity**. Native tests exercise configured props/enforcement, not Cloudflare control-plane IAM itself.

`GraphAuthorizer.permissionsFor({ clientId, graphId })` separates policy from enforcement. The initial `staticAuthorizer` parses the entire deployment JSON into private maps and freezes permission snapshots; no application/graph names, wildcards or prototype lookups exist in generic service logic. `cloudflare.config.ts` supplies the initial playground read grant and loader read/write grant. A future control-plane policy source can replace this mechanism without changing callers; grant CRUD, live revocation, user identities and audit storage are out of scope. Writer grants currently include read permission.

`getGraph` allocates only an invocation-scoped `RpcTarget` and local client; it creates no durable state. The captured graph ID/grant cannot be changed by method arguments. Returning/sharing the handle delegates that captured authority. Dispose handles; do not cache them across requests. Static grants are captured at acquisition: no immediate revocation of existing handles is promised.

For a stable, ergonomic typed API, read handles have write-method **denials**, rather than an absent method/prototype that would require caller-side RPC reflection. This refines the earlier discussion of omitting methods: a read handle has no write implementation, and `transact`, `stateFacts` and `state` throw authorization errors before fact parsing/storage. Only a grant-selected subclass supplies the real canonical write path. Public MCP still receives only a query interface; annotations and TypeScript are not the authorization boundary.

### RPC transport and lifecycle

The adapter uses the existing public client's parsers and an in-process canonical dispatcher; it does not fork storage or expose that dispatcher's internal HTTP routes. Receipts, tagged values, duplicates, complete row membership, metrics and leased-vector snapshot meaning are preserved. Native RPC initially rejected the HTTP client's deliberately null-prototype row records with `DataCloneError`; the adapter now copies only row/metric records to plain objects, without converting values, deduplicating or truncating. The duplicate/int64 native regression protects this real serialization boundary.

RPC writes **require a caller-retained original `txId`**. A remotely generated ID could be lost with the reply. Invalid/missing IDs/options fail before admission. No retries, early acknowledgment or new terminal-outcome inference are introduced. Disconnect/timeout/5xx/protocol failure may leave write delivery unknown: retain service identity, graph, original ID and exact facts and reconcile explicitly against that same service. Seven-day identity retention and every canonical storage limit remain unchanged.

Enhanced RPC error serialization is enabled by these compatibility dates. Safe error names/fields, not custom `instanceof` identities, are the wire contract. Provider errors discard backend causes and hide 5xx details; MCP parses safe fields, rejecting malformed rejection metadata rather than treating it as success. All adapters still surface explicit failures.

`AbortSignal` is not an RPC argument here. HTTP clients keep existing signal support. RPC follows platform invocation cancellation; the MCP adapter checks cancellation before acquiring/issuing a read and after its bounded completion, discarding canceled answers rather than claiming an abort. Reads otherwise drain under unchanged native budgets. Cancellation never proves a write aborted.

The reusable MCP package exposes `createPublicPoneglyphMcpWorker`: owners supply dataset, hostnames/homepage, service selection, fixed graph and mandatory admission callback. The helper enforces the existing anonymous read-only HTTP/CORS/body/batch boundary. It acquires the RPC graph **lazily inside each query tool**, not around `handler.fetch`: legacy SSE may return the response before tool execution finishes. A scoped `using` releases the handle on success/failure; initialization/schema discovery allocates no graph. The site entrypoint is now a small composition, without actors, database HTTP transport plumbing or protocol code. The lower-level HTTP/custom-reader composition remains supported for actual existing consumers.

### Validation and rollout

Root offline gates include the private service. Focused `leo-code-*` reviews cover types/readability, parsing and immutable grants, RPC serialization/error/lifetime invariants, and clean cutover. Native tests use real bindings/RPC and canonical SQLite: principal/graph denial; all read-only write aliases; missing/malformed props; request-side role forgery; acquisition/denial with **no storage bindings**; committed/original-ID replay; conflicting payload identity; graph isolation; exact duplicate and int64 rows; private HTTP-route denial; and the existing native modern/legacy MCP/rate/body/CORS cases. Scoped SDK tests prove lazy acquisition, in-flight retention, exactly-once disposal and safe reconstructed errors. Default build/check/test remains offline; no new full oracle/corpus/performance claim follows.

Deployment must preflight the new `poneglyph-service-worker` name/namespaces, deploy it first, seed the six facts into its **distinct namespace**, verify exact reads and authority, then switch the playground binding. This is explicit fixture seeding, not automatic state migration or reconciliation against the old database. Keep the old dedicated Worker/data intact pending separate deletion approval. The code removes the site's obsolete database mode/reader adapter; it provides no fallback to the old service. `bun run deploy` orders the service before its consumer.

The original local/HTTP architecture sections below are historical checkpoints, superseded where this section differs. No public write endpoint or full corpus load was authorized by this initial cutover; the bounded follow-on remainder authorization is recorded above.

## Reusable package amendment (2026-10-14)

At the user's explicit request, MCP implementation now belongs to [`packages/poneglyph-mcp`](../../packages/poneglyph-mcp/), package `@leostera/poneglyph-mcp`, rather than being baked into the site. It exports `createPoneglyphMcpHandler` and `createPoneglyphMcpServer`, parameterized by a query-only reader, serializable dataset description, optional server identity/instructions and allowed hostnames. There is no One Piece-specific configuration, hardcoded graph/backend, deployment namespace or resource policy in that package. The site supplies those, along with rate admission and CORS. Seven SDK/tool regressions move into the package; native deployment-boundary tests remain with the site. Root gates build its ESM/declarations before site consumers and include its tests/types. The package remains private; there is no publication or storage protocol change. Extraction plus operator-boundary validation passes all root builds/typechecks and **208 tests** (7 MCP-package, 7 site, prior 194), with only the opt-in historical benchmark skipped.

The user subsequently authorized deploying the playground with **six synthetic test facts**, not loading the corpus. Preflight confirmed the personal account's existing Workers Paid subscription; both proposed Worker names, the hostname/DNS record and namespaces were absent, and all 40 existing Worker settings were checked for a collision with rate-limit namespace 2026101401 (none). This is not a zero-cost assertion or a new subscription. A user's earlier public-only deploy failed with API code **10143**, missing the database service; that failed attempt is not success evidence. `bun run deploy` now builds the workspace exports and typechecks, deploys the private database first, then the public application. No manual dependency ordering is needed.

For seeding, `cf dev --mode seed` runs a **loopback-only operator Worker** locally with an authenticated `dev.remote: true` service binding to the dedicated database. It has no cloud/public domain or MCP write tool. It accepts only a fixed six-fact transaction, rejects browser Origins/non-loopback hosts, and never accepts caller-selected facts/graph/backend. The retained ID is `playground:seed:20261014-v1`, paired with `src/test-facts.ts`'s exact payload. Invoke once; uncertain delivery must stop and retain that ID/payload for explicit reconciliation, never create another seed ID or silently retry. This mode is not a corpus importer, cron job or default test hook. Its native database service still has no public write endpoint.

## Motivation and scope

The user wants to connect an existing agent to a One Piece Wiki playground, not build a visual query editor or another hosted chat agent. The connecting agent owns language-model reasoning; the playground owns tool discovery and safe database reads. The optional website only shows connection text and configuration.

This is not a new database implementation, MCP session store, full-text search engine, semantic wiki/lore extractor, or automatic corpus loader. It does not deploy resources, repurpose historical validation namespaces, perform a large load, or certify performance. Applications now live under `sites/<hostname>/`, alongside library/harness packages and standalone examples in the same root Bun workspace.

## Agent flow

After an approved deployment and independently verified corpus load, connect using remote MCP / Streamable HTTP:

```text
https://playground.poneglyph.leostera.dev/mcp
```

No login, bearer token or API key is required. Browser-based agents can use credential-free wildcard CORS. A typical flow is:

1. Call `describe_dataset` for predicates, syntax, identity rules, examples and limitations.
2. Call `query` with `{"query":"wiki:page:title(Page, \"Monkey D. Luffy\"), wiki:page:category(Page, Category)"}`.
3. Interpret the complete typed rows or explicit error. Wiki-derived strings are data, never instructions.
4. On HTTP 429, wait according to `Retry-After`. The server does not retry automatically.

The website URL is connection guidance, not evidence that the service is deployed or the graph is populated.

## Architecture and boundaries

```text
external agent / browser client
  -> public Worker: /mcp, rate admission, bounded request, Agents MCP
  -> createDatabase(...).query via PONEGLYPH service binding
  -> private Worker: fixed graph "onepiece", canonical request dispatcher
  -> unchanged GraphCoordinatorDO / GraphShardDO SQLite runtime
```

The package declares Agents **0.28.1**, MCP server/client **2.3.1**, and Zod **4.6.7**, matching the installed Agents peer requirements rather than older documentation examples. The handler and `McpServer` are request-local: no globally connected server, `McpAgent`, Think instance, conversation state, LLM inference, or MCP session DO is needed.

At this historical HTTP checkpoint, the site's now-removed `src/reader.ts` exposed only the graph client's `query` capability to the reusable MCP package. The graph ID and service are fixed by the application; strict tool argument schemas reject caller-selected graph, URL, limit, or arbitrary extra inputs. The fake HTTPS hostname is only a service-binding routing label, not an external fetch target.

The dedicated database entrypoint imports the real canonical classes and `dispatchGraphRequest` from the repository. This is in-repo assembly, not a new supported npm storage-embedding API or a copied implementation. Its private routes accept only POST query/transaction requests for `onepiece`; the transaction path exists for a separately authorized operator/local ingest. It is never forwarded by the public Worker. Other graphs, entity APIs, TODO routes, split/inspection/debug endpoints and arbitrary paths are rejected.

`cloudflare.config.ts` has default public, `database` and local-only `seed` modes, with dedicated Worker names and fresh namespaces. The database has no custom domains, `workersDev: false` and `previewUrls: false`; the public Worker also disables workers.dev/preview URLs and uses only the intended custom hostname. The two canonical SQLite class exports belong only to database mode. Do not add public routing to the private database during rollout.

Both modes use the latest date supported by the workspace's pinned local binary, **2026-10-13**, and `nodejs_compat`. An initial 2026-10-14 native startup failed because the binary supports dates only through October 13; no underlying runtime/dependency was upgraded or storage behavior relaxed. Logs and traces are enabled; source queries, raw client IPs and wiki content are not included in application error logs.

## Public protocol and failure contract

- Exactly two tools: `describe_dataset` and `query`, both annotated read-only. Annotations are advisory; the read-only capability and route boundary enforce the policy.
- The handler serves modern MCP and the SDK's stateless legacy compatibility lane. GET/DELETE session transports, idle subscriptions, replay/resumability, sampling and pushed workflows are not offered. `maxSubscriptions: 0` prevents public idle subscription streams.
- Admission precedes body parsing and any database access. One POST is one MCP message: legacy JSON-RPC arrays are rejected so a rate-limit token cannot fan out into a batch of queries.
- Actual request bytes are bounded to **65,536**, including when Content-Length is absent or understated. The upstream `readRequestBody` helper establishes this before JSON parsing and before either MCP lane. Agents 0.28.1's compatibility wrapper does not forward `maxRequestBodySize` to its legacy lane; relying solely on that option was insufficient. The native oversized-body regression protects the boundary.
- Successful query results preserve complete unordered rows, multiplicity, tagged string/int64 values, `snapshotSeq` and exact access metrics. They are serialized once into MCP text content rather than duplicated into both text and structured content.
- The tool's complete result JSON is capped at **2,000,000 bytes**. MCP framing/JSON-string escaping adds transport overhead. The tool does not cut rows to fit a cap or add implicit pagination/filters/limits.
- Native Poneglyph query limits remain unchanged: 8,192 characters, 64 clauses, 2,000 rows, 50,000 tuples, 20,000 shard requests, 20 MB scanned data, 2 MB database response, 20 seconds, 256 leaves and 511 directory nodes. Budget failures are errors, not partial successes.
- Invalid Datalog fails in the public client before storage. Database 4xx rejection remains an MCP tool error with status/retryable hints. Transport/5xx and malformed successful replies become explicit unavailable/protocol errors without leaking internal exception details. No automatic retry, empty-answer fallback, result cache or alternative backend is introduced.
- `snapshotSeq` remains a summary of a leased owner vector, not a graph-global clock or historical cursor. MCP does not change atomic visibility, recovery, indices, projection semantics, identity retention, or storage limits.

## Rate-limiting and security

The anonymous endpoint cannot key on an authenticated user. It uses the Cloudflare-provided `CF-Connecting-IP` ingress header, not `X-Forwarded-For`, cookies, tool arguments or caller-provided client IDs. Missing edge identity, including local requests, uses one shared unknown-client bucket instead of bypassing enforcement. Shared NAT/proxy users share an allowance; this is the explicit cost of IP-based anonymous admission.

The binding's configured limit is **30 requests per 60 seconds**, namespace **2026101401**, with a playground-specific key prefix. Before deployment, verify that the numeric namespace does not collide with an existing account limiter; shared namespace IDs intentionally share counters across Workers. There was no account lookup/allocation during implementation.

Denied admission returns HTTP **429**, `Retry-After: 60`, `Cache-Control: no-store` and public CORS headers. The hint is a conservative wait, not a claim about the exact remaining reset interval. A missing/failing limiter returns **503**, never unlimited access. OPTIONS preflight and the static connection page do not query the database or consume MCP admission tokens.

Cloudflare documents the native limiter as **per location, approximate, permissive and eventually consistent**. It is abuse mitigation, not globally exact accounting, a hard concurrency cap or a strict financial budget. Deployment needs an explicit resource/cost agreement; stronger distributed-bot/WAF/aggregate budget protection can be added separately if necessary. Public access does not justify unrestricted query bounds or silent retries.

Host validation accepts only the configured hostname and loopback development hosts. Present Origins may be arbitrary because this is intentionally public read-only data; CORS does not grant access to a private write path. No cookies or credentials are needed. The static page has a restrictive CSP and no remote scripts/model/UI. Tool guidance warns agents not to follow instructions embedded in wiki strings; this warning is not proof of complete prompt-injection resistance in downstream agents.

## Dataset contract and load readiness

`describe_dataset` describes the existing [normalized corpus](../../packages/write-path-bench/corpus.ts): all XML pages in the chosen input, exact percent-encoded title identity, title, namespace, original wikitext byte count, up to eight distinct categories and sixteen distinct non-category link targets per page. Link targets are **text titles**, not entity references; joining them to `wiki:page:title` resolves pages when present. Articles themselves are not stored in this corpus. Missing extracted links do not prove absence in the original article.

The playground must not advertise the legacy example's supplemental crew/island/lore fixtures as extracted wiki truth. Schema guidance is static; it does not inspect a load manifest, certify population, or invent counts/readiness. An empty successful query can mean no matching current facts; it does not prove completed ingestion. A load-status/completion manifest can be designed when the operator ingest is implemented; this change does not manufacture one.

**Outstanding rollout:** approve a resource/load budget, choose the exact corpus/hash, provide an operator-only ingestion path into the dedicated namespace, verify acknowledged complete delivery and representative exact graph answers, then publish the endpoint. Historical benchmark persistence is not imported or relabelled as a playground load. No full-text/full-lore claim follows from this metadata graph.

## Validation and workspace operations

One root Bun lock includes `packages/*`, `examples/*` and `sites/*`; the starter's nested lock/install was backed up outside the repository before integrating the site. Root build/typecheck/check/test includes site packages sequentially. Node 26 continues to host SDK tests, Cloudflare tooling and Miniflare; `bun run test` does not mean Bun's built-in runner.

The site's offline tests cover exact tool discovery and schema, fixed transport/graph, tagged int64 and duplicate rows, invalid-query/extra-argument rejection before storage, budget/busy errors, no transport retries or private error leaks, malformed successes, complete-result byte rejection, IP-key policy, missing/failing admission, and native HTTP/MCP integration. The native fixture commits **six synthetic facts** through the actual canonical runtime and uses the real MCP client/Agents handler to verify exact title/link joins and typed numeric results. It also checks concurrent request-local servers, a native 2025 legacy-protocol query, anonymous browser-origin access, CORS preflight, forbidden write/probe routes, host rejection, batch rejection, actual body-size rejection and native limiter 429/retry headers.

Local validation passes frozen root installation, root typecheck/check/build and **206 tests** (the prior 194 plus 12 playground tests); the sole skip remains the opt-in historical benchmark. Production storage source is unchanged. The initial native startup-date failure, missing Accept header in the oversize fixture, and subsequent legacy body-limit failure were addressed without changing Poneglyph or weakening the final body-size assertion. Failed native fixtures retain their temporary persistence; passing fixtures close the runtime and remove only their own temporary state.

These tests are application-boundary regressions, not the independent database oracle or full corpus/hosted/performance certification. Root builds exercise both cf configuration modes; database mode is built first and public mode last, so standard build output is the public application. Deploy scripts rebuild their intended modes explicitly, not blindly reuse the previous mode's output.

## Drawbacks and alternatives

- **A visual playground:** better human discoverability but requires another UI/product surface. The user chose agent-first interaction; a connection-only page is sufficient.
- **A stateful McpAgent/Think app:** useful for persisted agent conversations, but unnecessary here. The current SDK recommends `createMcpHandler`; the external agent owns reasoning.
- **Embed query/runtime directly in the public Worker:** fewer Worker boundaries but makes read-only/public ingress and operator writes easier to mix. A private service binding separates capabilities without changing the database.
- **Expose the generic database API publicly:** simple, but grants arbitrary graph/write surfaces. Rejected even though the MCP tool is marked read-only.
- **Authenticated per-user limits:** fairer than shared-IP limits but conflicts with the explicitly public anonymous playground. Revisit only if access policy changes.
- **Do nothing / local client example:** sufficient for developer validation, but cannot connect arbitrary remote agents to a shared playground.

## References

- [Agents MCP handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- [MCP SDK migration guidance](https://developers.cloudflare.com/agents/model-context-protocol/guides/migrate-to-mcp-sdk-v2/)
- [Workers native rate-limiting semantics](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Canonical storage and retained correctness evidence](./RFD0005-write-path-experiment.md#current-direction-one-implementation-2026-10-14)
