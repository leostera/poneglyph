# Poneglyph walkthrough

An interactive, incremental explanation of how a fact moves through Poneglyph. This is a learning aid, not a replacement for the implementation contracts in [RFD0004](rfds/RFD0004-expandable-cloudflare-sharding.md) and [RFD0005](rfds/RFD0005-write-path-experiment.md).

## Step 1: Facts, identifiers, and meaning

A fact draft contains URI identifiers for its source, entity, and field, plus a typed value and a retraction flag:

```ts
{
  source: "agent:release-assistant",
  entity: "app:task:rotate-key",
  field: "app:task:status",
  value: { type: "text", value: "open" },
  retraction: false,
}
```

The entity is a URI, for example `wiki:onepiece:page:Monkey%20D.%20Luffy`. The title text `"Monkey D. Luffy"` is a separate value in a fact about that entity. Poneglyph requires an absolute URI and canonicalizes it; the URI need not be an HTTP address.

A stored fact also has a storage-assigned `factId`, the committing transaction ID (`txId`), and `statedAt`. The transaction ledger assigns `statedAt` while admitting the transaction; it is a UTC record of when Poneglyph stated the fact, not a timestamp from the source material. Statement times are advanced to remain increasing, and facts in a batch receive successive millisecond values.

The fact log is append-only. A correction adds a retraction and a replacement assertion; it does not edit the earlier fact.

### Fields and URI conventions

`wiki:page:title` is a field URI: it names the property "page title." In Datalog notation, the field URI is written as the relation name:

```text
wiki:page:title(Page, "Monkey D. Luffy")
```

The URI's first component is its scheme (`wiki` here); the remaining text is an opaque identifier to Poneglyph. An application may give those pieces meaning by convention—for example, using `spotify:` or `onepiece:` for its own vocabulary—but Poneglyph does not interpret or group identifiers by those prefixes. In `wiki:onepiece:page:...`, `wiki` is the scheme; the application may define meanings for the rest.

You choose field URIs and should document and reuse them consistently. Poneglyph validates that a field is a URI and that a value is a supported typed value, but it does not require fields to be registered or enforce a field-specific type. The playground's read-only MCP `get_schema` observes active fields and root FactValue tags at an exact subtree-vector snapshot; it is not a catalog of required fields, universal types, or write constraints. A field's absence from one observation is not a schema violation.

### Combining facts into useful results

Facts about the same entity connect through that entity's URI. For example, a page-title fact and a category fact can be joined on the page variable to find categories for a titled page:

```text
wiki:page:title(Page, "Monkey D. Luffy"),
wiki:page:category(Page, Category)
```

Facts can also explicitly connect two entities with a reference value. For example, one fact can say a service is blocked by a task, and another can give that task's status:

```text
app:service:blocked-by(Service, Task),
app:task:status(Task, "open")
```

The query joins the reference to the task's entity URI. The relationship is meaningful because the application explicitly stored it; Poneglyph does not infer "blocked by" from prose, labels, or unrelated links.

### A flexible table analogy

As a mental model, you can imagine entities as rows and field URIs as column names: adding facts with a new field can feel like adding a column. Physically, however, Poneglyph stores each claim as a separate fact, not as a schema-changing SQL row. Queries join those facts and choose the result variables (the result columns). This makes the model flexible, while leaving field-specific rules to the application unless it validates them itself.

## Step 2: Submitting a fact draft

The application supplies a draft with `source`, `entity`, `field`, and a typed `value`. Set `retraction: true` only when withdrawing an exact active assertion; otherwise `false` (the client default) means this is an assertion. The draft does not include `factId` or `statedAt`.

```ts
const draft = {
  source: "agent:release-assistant",
  entity: "app:task:rotate-key",
  field: "app:task:status",
  value: { type: "text", value: "open" },
  retraction: false,
} as const;

const {txId} = await graph.transact([draft], {
  clientRequestToken: "release-assistant:rotate-key:submit-1",
});
```

`transact` sends the complete draft list as one write. The service mints the internal transaction ID and returns it only in a successful `{ txId }` receipt; request/network/protocol errors do not expose an ID because delivery may be unknown. An optional `clientRequestToken` is a graph-scoped application retry key, not the transaction ID: replaying the same token with the same facts returns the original receipt, including concurrent requests; changing the facts conflicts. Mappings are retained for seven days subject to bounded capacity. Without a token, every submission is a new transaction—even when facts match a previous write. The client never retries automatically. If delivery is uncertain and the application wants one logical operation, retain and retry the exact token and exact facts.

### Graph scope and coordination

A graph ID selects an isolated fact namespace. `db.defineGraph({ id })` creates a local client handle for that namespace; it does not register a SQL-style schema. A graph is roughly like a SQL database as a boundary, but it has no catalog of tables and columns: facts use field URIs. Separate graphs can isolate tenants, environments, or lifecycles, but Poneglyph does not join queries or transactions across them.

The current source has four Durable Object classes and an explicit request path: `GraphCoordinatorDO` → `GraphLedgerDO` → `GraphTreeDO` → `GraphShardDO`. `GraphCoordinatorDO` is a stateless graph-facing facade; it owns no fact rows, transaction journal, tree state, or application schema. `GraphLedgerDO` owns per-bucket transaction journals and the client-request-token mapping. `GraphTreeDO` owns one of 16 independent root trees: directory epoch, visibility sequence, entity reservations/locks, read leases, and split metadata. `GraphShardDO` owns prefix routers and leaf data; only leaves store facts and their derived indexes/projections. A precise read snapshot is a vector such as `{ root 0000: 17, root 0001: 9, ... }`, not one globally ordered graph sequence. The public transaction receipt contains only the server-minted `txId`; internal owner sequences remain part of the visibility/recovery protocol and are not a global graph clock.

Bindings are `GRAPH_FACADES`, `GRAPH_LEDGERS`, `GRAPH_TREES`, and `GRAPH_SHARDS`, each exporting its matching class. `dispatchGraphRequest` starts at the per-graph facade. That facade sends writes to a ledger, whose transaction engine contacts tree roots and shard participants. Instances are created when first addressed, so class/namespace names are not instance counts. For graph `onepiece`, one facade, up to 16 tree roots and 16 ledger buckets have deterministic names; shard nodes are created as the prefix tree expands.

## Step 3: Planning the write

The request enters `GraphCoordinatorDO` through `dispatchGraphRequest`. For a tokenized write, `dispatchPublicTransaction` routes to a `GraphLedgerDO` selected by `SHA-256(graphId || 0x00 || clientRequestToken)`. Inside that same ledger database, the token coordinator binds the token to the canonical fact-payload hash, mints the internal `txId`, and persists the token-to-transaction mapping before participant I/O. The mapping reserves capacity for both itself and its future transaction journal; journal creation fills the reserved slot so an unrelated write cannot strand the token at the bucket limit. The ID encodes its ledger bucket as `poneglyph:tx:token:<hex-bucket>:<uuid>`, so a retry, status lookup, and recovery reach the same ledger. Without a token, the service mints a fresh transaction ID and hashes it to a ledger bucket. These are distinct identities: the token identifies a caller's retryable logical operation, the transaction ID identifies the internal durable transaction, the payload hash binds that ID to exact facts, and the entity hash chooses fact storage.

The ledger then plans the write. The entity URI is the logical identity used in facts and queries; it is not replaced by a hash. For routing only, Poneglyph derives a virtual key as `SHA-256(graphId + 0x00 + entityUri)`. This uniform 256-bit key makes prefix splitting less sensitive to the URI's spelling or shared prefixes. It is stored as a derived routing/index value alongside the entity URI, not as a second semantic identity. The routing directory follows it to a leaf shard. Facts that land on the same leaf are grouped into one participant request. The `entity` determines the destination; the field and value do not. The ledger also groups affected entities by their tree owner. Before asking shards to prepare, it reserves those exact entity URIs at the owner trees. These are durable entity conflict fences, not a single global lock on every write in the ledger bucket.

For a concrete example, suppose the graph is `onepiece`, the entity is `onepiece:person:luffy`, the caller's token is `release-assistant:luffy-fruit-1`, and an illustrative transaction ID is `poneglyph:tx:token:d:00000000-0000-4000-8000-000000000000`. The entity routing key is `SHA-256("onepiece\\0onepiece:person:luffy")`, which begins `7b34…`; its first four bits are `0111`. The token hash selects ledger bucket `d`. The binary root `0111` is the leading hexadecimal digit `7` written in bits. The current shard name format records prefix depth (`4`) and packed hexadecimal prefix (`7`), hence `4-7`. Later splits consume one bit at a time: the next bit in `7b…` is `1`, so the first child prefix would be `01111`, encoded as `5-78`. The actor chain is:

```text
graph:onepiece:coordinator:v9
  -> graph:onepiece:coordinator:v9:ledger:d
  -> graph:onepiece:coordinator:v9:tree:0111
  -> graph:onepiece:node:v9:4-7
```

This example only calculates names; it does not send a write or assert that this is a canonical One Piece fact. A shorter name like `tree:7` could represent the same four-bit owner in a new naming scheme; it would address a different DO identity. There are no production users or legacy compatibility requirement, so if a simpler format is chosen, a clean destructive cutover and reseed is preferable to adding compatibility scaffolding. Ledger routing is separate from entity routing because one transaction can touch several entity prefixes. With a request token, its graph-scoped token hash selects the ledger bucket and the minted `txId` encodes that bucket; without a token, the minted `txId` is hashed to select the bucket. A two-hex-digit ledger prefix such as `b3` would mean a larger bucket scheme; today's ledger uses one hex digit (`0`–`f`). Because this batch contains one entity on one leaf, it uses the single-shard atomic path after preflight and the tree's entity reservation; it does not need multi-shard prepare/commit fan-out.

#### More facts for one entity vs. one fact for many entities

For Luffy, imagine one batch with three assertions about the same entity: a name, a Devil Fruit reference, and membership in `onepiece:crews:strawhats`. The fields and values differ, but all three facts have entity `onepiece:person:luffy`, so they share the routing key beginning `7b34…`, one owner tree (`tree:0111`), and one current leaf (`node:v9:4-7`). `planBatch` resolves that entity once and groups all three facts into one participant. For an untokenized write, suppose the service mints a `txId` whose hash selects ledger bucket `5` (its hash begins `51…`). After the same directory lookup, route, preflight, and tree reservation, the ledger calls that shard's `_atomic` endpoint with all three facts. It then records the witness, publishes the tree, finalizes, and returns success.

Now consider one transaction containing ten facts, one `memberOf onepiece:crews:strawhats` assertion for each illustrative entity below. The URI slugs are chosen just to demonstrate routing; this is not a claim that these exact assertions are present in the corpus.

| Entity URI | Routing hash prefix | Tree prefix | Current unsplit leaf |
|---|---:|---:|---|
| `onepiece:person:luffy` | `7b34…` | `0111` | `node:v9:4-7` |
| `onepiece:person:zoro` | `dda6…` | `1101` | `node:v9:4-d` |
| `onepiece:person:nami` | `e5d3…` | `1110` | `node:v9:4-e` |
| `onepiece:person:usopp` | `4888…` | `0100` | `node:v9:4-4` |
| `onepiece:person:sanji` | `775e…` | `0111` | `node:v9:4-7` |
| `onepiece:person:chopper` | `2083…` | `0010` | `node:v9:4-2` |
| `onepiece:person:robin` | `e7cb…` | `1110` | `node:v9:4-e` |
| `onepiece:person:franky` | `6fbf…` | `0110` | `node:v9:4-6` |
| `onepiece:person:brook` | `0e9b…` | `0000` | `node:v9:4-0` |
| `onepiece:person:jinbe` | `8bfb…` | `1000` | `node:v9:4-8` |

All ten facts travel under one `txId`, so they use one ledger (`ledger:c` for the illustrative batch ID `onepiece:tx:straw-hat-membership-batch-1`, whose hash begins `c0…`). The entity keys produce eight distinct owner trees and, in today's unsplit topology, eight distinct shard participants. Luffy and Sanji share leaf `4-7`; Nami and Robin share `4-e`, so each pair is grouped into one shard request. The ledger does ten entity route lookups, eight participant preflights, and locks the eight owner trees; after saving the exact plan, it sends `_prepare` to the eight participants, records the durable commit decision, sends `_commit` to them, publishes the eight trees, and finalizes. The parallel participant calls are one transaction's fan-out, not ten independent transactions. A split tree could make participant leaves differ from owner-tree count.

Both traces are hypothetical: imports are paused, and no write is sent. In the current API, the caller may supply a `clientRequestToken` but not an internal transaction ID; `transact` returns only `{ txId }` after commit. The example IDs above are illustrative routing inputs, not transactions that were sent.

Routing uses the tree directory's current leaf prefix, shard generation, and directory epoch. The epoch identifies the topology version; the generation identifies the active shard incarnation. Together they fence a stale route if a split changes ownership.

Poneglyph does not probe whether a named DO happens to exist and treat absence as a routing answer. It starts at the computed four-bit root, calls that `GraphShardDO`'s `/_route`, and follows persisted `leaf`/`router` metadata and the next hash bit until it reaches a leaf. `getByName` gives a deterministic stub; addressing an uninitialized name can create a fresh DO, so “the DO was absent” is not a safe way to discover the owner. Unlike Fokos's learned topology hints, Poneglyph currently re-reads its explicit prefix-router metadata rather than maintaining a cross-request route cache. A future cache would need epoch/generation validation and safe fallback to a known ancestor.

Preflight is an early, read-only check—not a reservation and not a commit. A candidate shard verifies that the facts really map to its range, that it is the active leaf at the expected generation, and whether the current capacity estimate admits the write or crosses the split trigger. The current trigger is a projected SQLite database size of 5,000,000,000 bytes (about 5 GB), counting the current database size plus estimated pending fact-log, index, projection, and transaction-staging growth. Preflight does not perform a split. If the trigger still applies on recheck after the tree reservation, the current transaction is aborted; the write path does not automatically split or prepare/commit the facts. Splitting is a separate operator/control-plane `POST /_split` to the graph coordinator facade, delegated to the owner tree. The tree coordinates a bounded copy from the source shard into two child shards, verifies the copy, then cuts over the directory epoch and treats the old source as a router. For Luffy's current `0111` prefix, the children would be `01110` and `01111`, named `node:v9:5-70` and `node:v9:5-78`. Once the split completes, submit a new transaction; a terminally aborted `txId` cannot be reused for the retry. After tree owners reserve entities, a shard's `prepare` performs the authoritative fact/retraction validation and capacity check while the write fences are held.

These checks cost extra DO calls. Preflight, participant prepare, and participant apply fan out in parallel across leaf shards; owner reservations and publication are currently sent one owner at a time. The number of participant leaves is bounded, so a transaction's coordination work is bounded too, but it grows with the number of owners/leaves it touches.

The ledger arms its recovery alarm before routing and preflight I/O. Once provisional checks pass, it saves the exact plan before reserving owners or sending state-changing participant requests. That ordering matters: if a request or response is lost, recovery knows which owners and shards this transaction was admitted to touch. It does not guess a new route halfway through an admitted transaction.

The Worker validates the graph route and calls `dispatchGraphRequest`; every query and write enters the per-graph `GraphCoordinatorDO` facade. The facade is stateless and does not hold a write mutex. Writes continue to one bucketed `GraphLedgerDO`, where different transaction IDs can progress concurrently and the same ID is serialized against itself. Tree roots fence conflicting entity writes, while different entities can be handled independently across roots/leaves.

Queries do pass through the one named graph facade, which plans/evaluates the Datalog query and fans scans out to shards. That makes it a potential per-graph query throughput point, though requests can overlap while awaiting I/O; it is not evidence by itself that the facade is the measured bottleneck. Also, a read lease and a pending writer reservation exclude one another on a tree root. A narrow query leases only its relevant root; a broad query may lease all 16 and temporarily prevent new writes in those roots. This is a real coordination/availability trade-off to measure, not an unlimited-throughput design.

## Step 4: Prepare and commit

For a multi-shard write, each participant first validates and durably stages its portion as `prepared` in its own SQLite database. Concretely, the shard inserts a row into its separate `shard_transactions` table with `status = 'prepared'` and the participant batch in `payload_json`. It does **not** insert those facts into `fact_log`, `active_facts`, `active_values`, or `entity_versions` yet. Queries do not scan `shard_transactions`, so there is no need to put a null transaction ID in the fact rows or teach every query to filter out prepared facts. The in-memory staged copy is only a cache; the SQLite payload is the durable recovery copy.

This is not yet the visible fact state. If a participant permanently rejects the write, the ledger asks every participant to cancel its staged portion, then releases the owner reservations. If a response is uncertain or a participant is temporarily unavailable, the ledger keeps the transaction's durable progress and recovery retries the same transaction identity and payload.

Only after every participant has prepared does the ledger durably record the `committing` decision. That is the point of no return: recovery must finish the commit, never turn it into an abort. The ledger asks each shard to apply its part. In one local SQLite transaction, the shard inserts the facts into `fact_log`, updates the active-fact/value and entity projections, marks its `shard_transactions` row committed, and clears the staged `payload_json`. The fact rows carry the non-null `txId` and commit sequence. Those calls are idempotent, so if a shard applied the data but its response was lost, repeating the same call returns the existing outcome instead of adding the facts twice.

After all participants confirm apply, the ledger publishes the commit through the affected tree coordinators. A tree publishes its sequence and releases those entity fences only after the shard work is complete. A multi-tree query acquires a read lease from every tree it needs; if any tree is still fenced, the query cannot return a mixed old/new vector. Once publication completes, the ledger records the terminal outcome and returns the committed receipt. A request that loses that response is reconciled by retrying the same `txId` and exact facts.

A one-shard write takes a shorter path: the shard performs one local atomic write and returns a durable decision witness, then the tree publishes visibility. It does not need the multi-participant prepare/commit fan-out, but it still needs a recoverable receipt and a visibility step. The important distinction is that each DO's SQLite transaction is atomic only inside that DO; the ledger is what coordinates a batch that spans several DOs.

### Swim lanes: one batch across two shards

The diagram shows the multi-shard path through all four actor roles. The graph coordinator facade routes the public write to one ledger bucket; the ledger contacts the affected tree roots and shard participants. Tree coordinators return per-root visibility/epoch state, while GraphShardDO router nodes resolve entity keys to leaf shards. Calls to multiple trees are made for the transaction's owner roots.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant W as Worker
    participant G as Graph coordinator facade
    participant L as Transaction ledger bucket
    participant T as Tree coordinator(s)
    participant R as Shard routing nodes
    participant A as Shard A
    participant B as Shard B

    C->>W: POST graphId + facts + optional clientRequestToken
    W->>G: dispatchGraphRequest
    G->>L: dispatchPublicTransaction
    L->>L: Persist token/intent; arm recovery alarm
    L->>T: Read owner epochs and visible sequences
    T-->>L: Return per-root state
    L->>R: Resolve entity keys through prefix directory
    R-->>L: Return leaf prefixes and generations
    L->>A: Preflight this shard's facts
    L->>B: Preflight this shard's facts
    A-->>L: Capacity / routing check
    B-->>L: Capacity / routing check
    L->>L: Persist exact participant plan
    L->>T: Reserve affected entity URIs
    T->>T: Persist entity fences and write tickets
    T-->>L: Reservations confirmed

    par Prepare participants
        L->>A: Prepare participant payload
        A->>A: SQLite: insert prepared row + payload_json
        A-->>L: Prepared (not query-visible)
    and
        L->>B: Prepare participant payload
        B->>B: SQLite: insert prepared row + payload_json
        B-->>L: Prepared (not query-visible)
    end

    alt Permanent rejection during prepare
        L->>A: Cancel any prepared payload
        L->>B: Cancel any prepared payload
        L->>T: Release reservations as aborted
        L-->>W: Aborted outcome
    else All participants prepared
        L->>L: Persist irrevocable COMMIT decision
        par Apply participants
            L->>A: Commit same txId + payload hash
            A->>A: SQLite: write fact_log + indexes; mark committed
            A-->>L: Applied
        and
            L->>B: Commit same txId + payload hash
            B->>B: SQLite: write fact_log + indexes; mark committed
            B-->>L: Applied
        end
        opt Participant unavailable or response lost after decision
            L->>L: Keep phase=committing; recovery retries
            L->>B: Retry same commit identity
            B-->>L: Existing applied outcome
        end
        loop Each affected tree
            L->>T: Publish commit sequence
            T->>T: Advance visible sequence; release entity fences
            T-->>L: Published
        end
        L->>L: Persist terminal outcome
        L-->>W: Committed receipt
        W-->>C: Success + { txId }
    end

    opt After successful commit
        C->>W: POST query
        W->>G: Dispatch query to graph facade
        G->>T: Acquire required read lease(s)
        T-->>G: Snapshot sequence vector
        G->>A: Scan at leased sequence
        G->>B: Scan at leased sequence
        A-->>G: Rows
        B-->>G: Rows
        G-->>W: Complete query result
        W-->>C: Query result
    end
```

If a shard permanently rejects during prepare, the ledger cancels any prepared payloads and releases the reservations as aborted. If a shard is unavailable after the durable commit decision, the ledger keeps the transaction in `committing` and recovery retries the same participant commit; it must not abort. Until all participants apply and the relevant tree fences are published, a query that needs those trees cannot acquire a complete read vector.

### Code-level call chain

**Write:** `HttpGraphClient.transact` validates the batch and POSTs facts plus an optional `clientRequestToken` to `/transactions`. `dispatchGraphRequest` sends it to `GraphCoordinatorDO.fetch`; that facade calls `dispatchPublicTransaction`. For a token, `ClientRequestTokenCoordinator` inside the selected `GraphLedgerDO` atomically records the token mapping and server-minted bucket-encoded `txId`; without a token, the dispatcher mints a fresh ID and hashes it to a ledger bucket. `TransactionLedger.fetch` validates graph/ledger identity and calls `DistributedTransaction.execute`. Its `advance` method plans routes (`planBatch`), preflights participants, reserves tree owners, then drives prepare/apply/publish. The internal committed witness is validated and shaped to the public `{ txId }` receipt. The trusted import route instead calls `transactApprovedBatch` through the same facade/ledger path with the exact identity from its approved plan.

**Query:** `HttpGraphClient.query` POSTs to `/query`; `dispatchGraphRequest` sends it to `GraphCoordinatorDO.fetch`. The facade calls `runQuery`, acquires the required `GraphTreeDO` read lease(s), routes to `GraphShardDO` leaves, scans their SQLite indexes, evaluates Datalog joins, and releases the leases before returning the result.

**Observed schema:** `HttpGraphClient.getSchema` POSTs an empty request to `/schema`. The graph facade pins all 16 tree snapshots, lists leaves at each directory epoch, and asks those leaves for distinct active field/root-value-tag pairs at their own leased sequence. It merges the complete observations, returns the exact snapshot vector (with `snapshotSeq` only as its maximum), then releases the leases. It fails on response/fan-out limits rather than returning a partial schema. This is a read view over current facts, not persisted schema enforcement.

### Deployed One Piece names (account snapshot, 2026-10-16)

The public playground Worker is `playground-poneglyph-leostera-dev` on `onepiece.poneglyph.dev`; its `PONEGLYPH` service binding targets the Worker Entrypoint `poneglyph-service-worker`. That binding's `playground` identity is read-only. The separate `PONEGLYPH_IMPORT` binding uses the `playground-importer` identity; hosted imports remain paused unless explicitly authorized.

For graph ID `onepiece`, the deployed names follow these exact patterns:

- Query facade: `graph:onepiece:coordinator:v9`.
- Tree coordinators: `graph:onepiece:coordinator:v9:tree:0000` through `...:tree:1111`.
- Ledger buckets: `graph:onepiece:coordinator:v9:ledger:0` through `...:ledger:f`; the transaction's first hex digit of `SHA-256(txId)` selects one.
- Initial shard leaves: `graph:onepiece:node:v9:4-0` through `...:4-f`; deeper split prefixes produce longer prefix tokens.

At this historical account snapshot, 33 `GraphCoordinatorDO` objects and 16 `GraphShardDO` objects were listed for `poneglyph-service-worker`, matching one facade, 16 tree roots, 16 ledger buckets, and 16 initial shard leaves when those roles still shared the coordinator class. The Durable Objects listing API returned opaque IDs rather than friendly names; the instance names were expanded from deterministic `getByName` formulas. This inventory predates the four-class source refactor below; it is not evidence that the new `GraphLedgerDO` or `GraphTreeDO` namespaces are deployed.

#### One hypothetical write through the current source chain

This follows the single-fact example with `txId = poneglyph:tx:token:d:00000000-0000-4000-8000-000000000000`: the encoded ID selects ledger bucket `d`, and the entity hash beginning `7b…` selects tree `0111` and the current unsplit leaf `4-7`. The diagram describes the local source routing; this refactor has not been deployed and it does not send a write. Hosted imports remain paused, and the public `PONEGLYPH` identity is read-only.

```mermaid
sequenceDiagram
    participant C as Access-approved import caller
    participant P as playground-poneglyph-leostera-dev Worker<br/>POST /import
    participant S as poneglyph-service-worker<br/>PONEGLYPH_IMPORT clientId=playground-importer
    participant G as GraphCoordinatorDO<br/>graph:onepiece:coordinator:v9
    participant L as GraphLedgerDO<br/>graph:onepiece:coordinator:v9:ledger:d
    participant T as GraphTreeDO<br/>graph:onepiece:coordinator:v9:tree:0111
    participant R as GraphShardDO<br/>graph:onepiece:node:v9:4-7

    C->>P: POST the approved batch
    P->>P: Check Access identity, plan, rate limit, exact batch
    P->>S: PONEGLYPH_IMPORT.getGraph({ graphId: onepiece })
    S-->>P: ReadWriteGraph capability
    P->>S: graph.transactApprovedBatch(facts, { txId })
    S->>G: dispatchGraphRequest → POST /transactions
    G->>L: dispatchPublicTransaction → POST /_transact
    L->>L: Persist intent + payload hash; arm recovery
    L->>T: _tree-directory
    L->>R: _route, then _preflight
    L->>L: Persist exact plan
    L->>T: _tree-lock for the Luffy entity
    L->>R: _atomic (single-shard transaction)
    R-->>L: Durable local decision witness
    L->>T: _tree-finish publishes visibility
    L->>R: _decision-finalize
    L-->>S: Committed receipt
    S-->>P: RPC result
    P-->>C: Import receipt
```

The last hosted service snapshot predates this source-only four-class refactor: it used the unversioned `GraphCoordinatorDO` and `GraphShardDO` namespaces and Worker `poneglyph-service-worker`; the playground Worker was `playground-poneglyph-leostera-dev`. Current local source uses routing version 9 in deterministic instance names such as `graph:onepiece:coordinator:v9` and `graph:onepiece:node:v9:root`, while Worker and class/namespace names remain unversioned. The current source declares `GraphCoordinatorDO`, `GraphLedgerDO`, `GraphTreeDO` and `GraphShardDO`; deployment has not been performed as part of this refactor. The v9 graph remains fresh; no facts were migrated, imported or seeded.
