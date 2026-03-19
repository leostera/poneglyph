# RFD0004 - Connectors

- Feature Name: `connectors`
- Start Date: `2026-03-14`
- RFD PR: `TBD`
- Poneglyph Issue: `TBD`

## Summary
[summary]: #summary

Poneglyph will introduce the concept of a connector: a named, product-specific capability that grants access to some external resource and defines how that resource should populate metadata in the Poneglyph knowledge graph.

A connector is not a generic transport or file-format adapter. It is a concrete integration with a real external product or service, such as:

- `gmail`
- `obsidian`
- `plex`
- `github`

and not abstract categories like:

- “IMAP mailbox”
- “folder of markdown files”
- “directory of movie files”

This RFD defines what a connector is, what responsibilities it has, and what it is explicitly not responsible for. It intentionally does not yet define:

- the full control-plane database
- OAuth/session persistence
- job scheduling
- UI workflows
- the long-running ingestor runtime

Those will build on top of the connector abstraction later.

This RFD is also now informed by two real connector spikes:

- `plex`, which proved the baseline connector shape
- `gcal`, which proved the first OAuth-backed, resource-scoped connector flow

Together they surfaced a few corrections we should carry into future
connectors.

## Motivation
[motivation]: #motivation

The next major Poneglyph capability is ingestion.

Poneglyph is already able to:

- store append-only facts
- maintain a synchronous active graph
- consolidate entities
- run projections
- answer graph queries
- expose itself over MCP

What it does not yet have is a durable, well-defined way to connect to external systems and turn their data into facts and metadata in the graph.

This needs a first-class concept because external integrations are not all the same.

For example:

- Gmail is not just “email over some protocol”; it has Gmail-specific concepts like threads, labels, message IDs, drafts, and OAuth flows.
- Obsidian is not just “markdown files on disk”; it has vaults, note paths, frontmatter conventions, wikilinks, and plugin-oriented user expectations.
- Plex is not just “a folder of movies”; it has libraries, metadata models, watched state, agents, and a concrete product surface users already understand.

If Poneglyph models these integrations too generically too early, the connector surface will become vague and hard to configure, document, and reason about.

So the first step should be to define connectors in product terms.

The Plex spike validated that this approach is correct:

- a product-specific connector is easy to explain and configure
- it can declare a product-specific schema cleanly
- it can emit ordinary graph facts without special-casing the runtime
- it can run under daemon supervision without being folded into `poneglyph`

It also showed that we need explicit rules for:

- connector schema bootstrap
- fact-batch bridging into `Poneglyph`
- canonical identity resolution

The Google Calendar spike extended those lessons:

- some connectors are multi-phase, not just long-running workers
- OAuth, resource discovery, and resource selection belong outside the sync
  runtime
- `control.db` is required to persist connection state, selected resources, and
  sync checkpoints
- browser auth should remain HTTP-native, not be forced through MCP or
  GraphQL

## Guide-level explanation
[guide-level-explanation]: #guide-level-explanation

A connector is a built-in integration type that does three things:

- grants access to one external resource
- defines the schema used to represent that resource in Poneglyph
- translates the external resource into graph metadata and facts

The “external resource” may be:

- a remote service like Gmail or GitHub
- a local application data source like an Obsidian vault
- some other concrete product-owned system

The important point is that the connector gives Poneglyph a product-aware doorway into that resource.

Examples:

- a Gmail connector knows how to authenticate with Gmail, list messages and threads, and emit Gmail-shaped facts
- an Obsidian connector knows how to read a vault, interpret notes and links, and emit Obsidian-shaped facts
- a Plex connector knows how to read Plex libraries and metadata and emit Plex-shaped facts

Each connector should define:

- its stable name, like `gmail` or `obsidian`
- a human-readable display name and description
- the external resource it grants access to
- the schema vocabulary it uses for that resource
- the configuration shape required to use it

In practice, the Plex spike established one more constraint:

- connector configuration should be a typed Rust struct, not a bag of
  unstructured JSON values

This does **not** mean the connector itself owns persistence or UI.

Instead:

- the connector defines the capability
- later, a connection will be one persisted configured instance of that connector
- later still, an ingestor will be a long-running worker that uses that connection to produce facts

For example:

- connector: `gmail`
- connection: “Leo’s personal Gmail account”
- ingestor: “sync Gmail every 5 minutes and append new facts”

### Learnings from the Plex spike

The first connector implementation, `plex`, established a few concrete rules:

- connectors should emit ordinary `Vec<Fact>` batches
- the connector runtime, not the connector itself, should own the bridge into
  `Poneglyph.state_facts(...)`
- connector schema should be bootstrapped once before steady-state ingestion
- steady-state runs should emit data facts only, not restate schema repeatedly

It also clarified what connectors should not own:

- connector-local supervision logic
- connector-local persistence separate from graph facts
- ad hoc runtime protocols for writing into `Poneglyph`

### Learnings from the Google Calendar spike

The second connector implementation, `gcal`, clarified that many real
connectors are not a single-step "run and ingest" operation. Instead, they have
at least three distinct phases:

1. authorization
2. resource discovery and selection
3. sync

For Google Calendar specifically, that means:

- the user authorizes access to Google
- Poneglyph lists available calendars
- the user selects which calendars should sync
- only then can the connector runtime ingest events

This proved a few architectural points:

- `ConnectorRuntime` is only responsible for the sync phase
- OAuth/browser callbacks belong to the HTTP API layer
- resource discovery and resource selection are control-plane operations
- selected resources are part of durable connector state, not config-file input
- sync checkpoints such as `nextSyncToken` must be stored in `control.db`

It also validated a hosted-auth handoff pattern that we should preserve:

- hosted `/auth/:provider/login`
- hosted `/auth/:provider/callback`
- local `/auth/:provider/grant`

In that pattern, the hosted API performs the confidential code exchange, then
hands a one-time grant back to the local app, which redeems it and stores the
connection locally.

### Why connectors are specific, not generic

Poneglyph should prefer concrete integrations over generic adapters because:

- users think in terms of products they use, not abstract protocols
- schemas are product-specific
- ingestion behavior is product-specific
- documentation is easier when the unit is a real thing
- UI configuration will be clearer when users choose “Gmail” or “Obsidian”, not an abstraction they have to interpret

That means the first connector list should be made of concrete product integrations.

## Reference-level explanation
[reference-level-explanation]: #reference-level-explanation

## Connector concept

The system should introduce a `Connector` concept with semantics roughly like:

- stable identifier
- display name
- description
- version
- external resource description
- configuration schema
- schema definition or schema bootstrap facts

Exact Rust naming can evolve, but the concept should remain stable.

Possible Rust shape:

```rust
pub struct ConnectorDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub resource: String,
    pub config: ConnectorConfigDefinition,
}
```

This is only illustrative. The important part is the boundary:

- connectors are code-defined capabilities
- they are not yet persisted user instances

After the Plex spike, the practical connector shape looks more like this:

```rust
pub struct PlexConfig {
    pub enabled: bool,
    pub base_url: Option<String>,
    pub token: Option<String>,
    pub libraries: Vec<String>,
}

pub struct PlexConnector { ... }

impl PlexConnector {
    pub fn init(config: PlexConfig) -> Result<Self>;
    pub fn name(&self) -> &'static str;
    pub fn schema_facts(&self) -> Vec<Fact>;
    pub async fn run(self, tx: mpsc::Sender<Vec<Fact>>) -> Result<()>;
}
```

This should not yet be read as the final trait for every connector, but it does
capture the current proven boundary:

- typed config in
- fact batches out
- runtime-owned supervision and bridging

The Google Calendar spike adds a second proven boundary next to the connector
itself:

```rust
pub struct GoogleOAuthConnection {
    pub provider_account_id: String,
    pub email: Option<String>,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
}

pub struct GoogleCalendarResource {
    pub calendar_id: String,
    pub summary: String,
    pub selected: bool,
    pub sync_token: Option<String>,
}
```

These are illustrative, but they capture the current architectural reality:

- OAuth-backed connectors need persisted connection records
- discoverable resources need durable selection state
- per-resource sync state is part of the connector control plane

## Connector responsibilities

A connector should be responsible for:

- declaring what external resource it grants access to
- declaring what configuration it needs
- declaring or contributing the schema it writes against
- translating external product data into graph metadata and facts

Operationally, the Plex spike suggests a connector’s responsibilities are best
read as:

- `init(config)` validates access requirements and constructs a client
- `schema_facts()` declares connector schema vocabulary
- `run(...)` fetches external data and emits fact batches

A connector should **not** yet be responsible for:

- storing its own credentials or settings
- deciding when it runs
- supervising its own background tasks
- exposing UI forms directly

Those concerns belong to the later control-plane and daemon layers.

More concretely, the following responsibilities should remain outside the
connector itself:

- creating the shared channel that receives connector fact batches
- forwarding those batches into `Poneglyph`
- supervising multiple connectors together
- deciding whether schema bootstrap is required before a connector starts
- running OAuth authorization flows
- listing resources for user selection
- storing connection credentials or selected resources
- checkpointing per-resource sync cursors and last-sync status

## Schema relationship

Each connector will usually imply a schema.

For example:

- a Gmail connector may emit facts about accounts, threads, messages, labels, and participants
- an Obsidian connector may emit facts about vaults, notes, tags, paths, and wikilinks
- a Plex connector may emit facts about libraries, movies, shows, episodes, and watched state

That schema should still be represented as ordinary schema facts in Poneglyph.

This means a connector should be able to provide either:

- bootstrap schema facts directly, or
- a declarative schema definition that can be turned into schema facts

The exact mechanism can be finalized in a later RFD. The requirement is that connector-defined vocabulary becomes ordinary graph schema, not an opaque side registry.

The Plex spike narrowed the current implementation direction:

- connector schema should currently be emitted as ordinary schema facts
- the daemon/control-plane runtime should ensure those facts exist once
- connectors should not restate schema on every normal sync run

`ConnectorConfigDefinition` here should be understood as a typed connector-configuration description owned by the connector subsystem, not an unstructured JSON blob.

## Relationship to future concepts

This RFD intentionally separates three concepts:

- `Connector`
  a code-defined integration type

- `Connection`
  a persisted configured instance of a connector

- `Ingestor`
  a runtime worker that uses one connection to append facts

The Google Calendar spike showed that a `Connection` is not a theoretical future
concept. For OAuth-backed connectors it is operationally required now.

This RFD still centers the `Connector` concept, but from here on it should be
read together with these derived consequences:

- connectors may require one or more persisted `Connection` records
- connections may have discoverable `Resource` records
- resources may need explicit user selection before sync begins
- ingestors should consume those persisted connection and resource records

## Operational consequences

Taking this approach means:

- `poneglyph` stays focused on graph runtime concerns
- connector logic can be introduced without immediately finalizing control-plane storage
- UI work later can present connector choices in product terms
- schema work stays aligned with ordinary facts

It also means we defer some decisions:

- where connections are stored
- how credentials are managed
- how workers are supervised
- how connector sync state is checkpointed

The `gcal` spike narrows some of those deferrals in practice:

- connections are currently stored in `control.db`
- credentials are currently stored in `control.db`
- selected resources are currently stored in `control.db`
- sync state is currently stored in `control.db`

What remains deferred is not whether these concepts exist, but how broadly we
generalize them across every future connector.

The Plex spike also clarified some runtime consequences we should now preserve:

- connector runtimes should own a shared fact-batch channel
- connectors should be pure producers into that channel
- a single bridge task should forward fact batches into `Poneglyph`
- batch-shaped write APIs such as `Poneglyph.state_facts(Vec<Fact>)` matter for
  connector ergonomics

The Google Calendar spike adds more runtime consequences we should preserve:

- sync workers should load selected resources from persistent state, not config
- sync workers should resume from saved checkpoints when the upstream API
  supports it
- startup should not imply full re-import if a connector can resume
- browser-native auth endpoints should remain HTTP routes, not GraphQL or MCP
  calls

That deferral is intentional. The connector abstraction should be stable before those layers build on top of it.

## Alternatives considered

### Generic source adapters

Examples:

- filesystem
- markdown
- email
- media library

Rejected for now because they are too abstract and force product-specific logic to leak into configuration, schema design, and ingestion code anyway.

### Treat connectors as just projections

Rejected because projections in sPoneglyph are downstream derived workers over local graph state, while connectors are upstream integrations that grant access to external resources and introduce new data into the graph.

### Put connector logic directly into `poneglyph`

Rejected because the graph runtime should not need to know Gmail, Plex, or Obsidian by name. That logic belongs in a higher integration/control-plane layer.

## Unresolved questions

- Should connector definitions live in a new `poneglyph-ctl` crate, or in a dedicated `poneglyph-connectors` crate?
- How should a connector contribute schema facts on first use?
- Should connector configuration schemas be JSON Schema, Rust types, or both?
- How should connectors expose sync modes like full import, incremental import, or one-shot pull?
- How should connectors report capabilities such as “read-only”, “webhook-capable”, or “requires OAuth”?
- How should connectors resolve canonical entity identity instead of baking
  external IDs directly into canonical URIs?
- Should identity resolution be driven by graph queries, search, or a connector
  helper built on top of the graph?
- How should connectors version and evolve schema bootstrap facts over time?
- How should the local and hosted `poneglyph-api` roles be described for
  OAuth-backed connectors?
- Should resource discovery results always be persisted, or can some connectors
  treat them as ephemeral?
- How should manual sync triggers and connector status inspection be exposed to
  the app and MCP?

## Future possibilities

- persisted `Connection` records in a control-plane database
- an ingestor runtime supervised by `poneglyphd`
- connector health and sync status APIs
- enrichment jobs that consume facts and emit new facts
- agentic ingestion flows that sit above connector primitives
