# RFD0003 - Schema Discovery

- Feature Name: `schema-discovery`
- Start Date: `2026-03-13`
- RFD PR: `TBD`
- Poneglyph Issue: `TBD`

## Summary
[summary]: #summary

Poneglyph will introduce a schema-discovery subsystem that represents schema as ordinary facts in the graph, exposes a typed schema-definition API from the core runtime, and makes that schema available to agents through a new MCP tool.

This schema layer exists to solve a practical usability problem: agents can write Datalog, but they cannot reliably guess which predicates, URI conventions, kinds, namespaces, or field shapes are present in a given local graph.

The schema subsystem will:

- define and ship a small built-in base schema vocabulary for namespaces, kinds, and fields
- represent both built-in and user-defined schema as ordinary append-only facts
- derive schema from the pure fact history, not from `active_facts`
- preserve schema knowledge even if the underlying data facts that first introduced it are later retracted
- expose a typed schema-definition API from `poneglyph`
- add an MCP `getSchema` tool so LLMs can discover the graph before writing queries

In the first iteration, schema is descriptive and bootstrapped:

- descriptive, because it documents what has been defined in the graph so far
- bootstrapped, because Poneglyph ships with a base vocabulary useful for defining new schema

It does not yet enforce writes against declared schema.

## Motivation
[motivation]: #motivation

Recent MCP usage made the main discoverability gap obvious.

An LLM using the current MCP tools could:

- state facts
- run Datalog queries
- fetch entities
- search the graph

but it could not answer basic questions like:

- what URI shape should entities and fields use?
- which predicates exist?
- which namespaces and kinds are available?
- what does valid Datalog look like against this graph?
- how do I define a new kind or field consistently?

The result was repeated guesswork and poor first-query ergonomics.

The most important feedback points were:

- URI format expectations were opaque
- field naming conventions were opaque
- query syntax was only partially discoverable through failures
- there was no schema or examples endpoint

This is not just an MCP problem. It is a missing backend capability.

Poneglyph already maintains:

- the append-only fact log as durable truth
- a strongly consistent active graph for query execution
- eventual entity and search projections

What it does not yet maintain is a durable schema history explaining what the graph means at the namespace, kind, and predicate level.

The old prototype in [crates/old-borg-memory](/Users/leostera/Developer/github.com/leostera/poneglyph/crates/old-borg-memory) showed that raw observed predicates are not enough. A usable graph needs a small schema vocabulary for talking about:

- namespaces
- kinds
- fields
- field domains and ranges
- field cardinality and identity semantics

This RFD adopts that lesson while keeping schema grounded in append-only facts.

## Guide-level explanation
[guide-level-explanation]: #guide-level-explanation

Poneglyph should be able to answer:

- what built-in schema vocabulary exists for defining new schema?
- which namespaces exist?
- which kinds exist?
- which fields exist?
- what are the docs and names for those things?
- for fields, what are their domain, range, value type, cardinality, deprecation, and identity semantics?

For example, after facts like:

- `spotify schema:type schema:namespace`
- `spotify schema:name "Spotify"`
- `spotify schema:doc "The Spotify knowledge graph namespace."`
- `spotify:artist schema:type schema:kind`
- `spotify:artist schema:name "Artist"`
- `spotify:artist schema:doc "An artist in the Spotify knowledge graph."`
- `spotify:field:displayName schema:type schema:field`
- `spotify:field:displayName schema:name "Display Name"`
- `spotify:field:displayName schema:doc "The user-facing display name for an entity."`
- `spotify:field:displayName schema:field:domain spotify:artist`
- `spotify:field:displayName schema:field:valueType "text"`

Poneglyph should be able to report a schema definition roughly like:

```json
{
  "namespaces": [
    {
      "uri": "spotify",
      "name": "Spotify",
      "doc": "The Spotify knowledge graph namespace."
    }
  ],
  "kinds": [
    {
      "uri": "spotify:artist",
      "name": "Artist",
      "doc": "An artist in the Spotify knowledge graph."
    }
  ],
  "fields": [
    {
      "uri": "spotify:field:displayName",
      "name": "Display Name",
      "doc": "The user-facing display name for an entity.",
      "domain": "spotify:artist",
      "valueType": "text"
    }
  ]
}
```

An MCP client would call `getSchema` before writing Datalog, inspect the available namespaces, kinds, and fields, and then write better queries immediately.

The same MCP client should also be able to see the built-in vocabulary for defining new schema. For example, it should be able to discover that:

- namespaces are entities
- kinds are entities
- fields are entities
- namespaces, kinds, and fields all have at least a `schema:name` and `schema:doc`
- fields can declare domain, range, value type, cardinality, deprecation status, and identity semantics

### Why schema must come from pure facts

Schema must not be derived only from `active_facts`.

Example:

1. a user defines `local://music` as a namespace and `local://music/artist` as a kind
2. data using those definitions is later retracted or deleted
3. the graph no longer has active data facts referring to them

If schema were derived only from active data, the system would forget that the schema ever existed. That is bad for:

- agent discoverability
- debugging
- Datalog authoring
- explainability

Schema should therefore be derived from the append-only fact history and retained as historical knowledge, even when the data that first introduced it is no longer active.

This means schema is closer to knowledge about the graph’s vocabulary than a summary of currently active rows.

## Reference-level explanation
[reference-level-explanation]: #reference-level-explanation

## Core concepts

The first iteration should introduce these conceptual types:

- `BaseSchema`
  - the built-in schema facts shipped with Poneglyph
  - useful for defining namespaces, kinds, fields, and schema metadata

- `SchemaDefinition`
  - the query-facing schema view returned to callers
  - built from ordinary schema facts in the graph

- `NamespaceSchema`
  - effective description of one namespace

- `KindSchema`
  - effective description of one kind

- `FieldSchema`
  - effective description of one field

The exact Rust names can evolve, but these are the concepts the implementation should preserve.

## Base schema vocabulary

Poneglyph should ship with a small built-in schema vocabulary, inspired by the old prototype, so the system can describe schema using its own fact model.

The first version should include built-in entities for:

- namespaces
- kinds
- fields

Useful initial built-in kinds include:

- `schema:namespace`
- `schema:kind`
- `schema:field`

Useful initial built-in fields include:

- `schema:type`
- `schema:name`
- `schema:doc`
- `schema:sameAs`
- `schema:field:domain`
- `schema:field:range`
- `schema:field:valueType`
- `schema:field:cardinality`
- `schema:field:deprecated`
- `schema:field:identity`

These should be enough to define:

- new namespaces
- new kinds of entities
- new fields

Each namespace, kind, and field should have at least:

- a name
- a description

Fields may additionally define:

- domain
- range
- value type
- cardinality
- deprecated
- identity

This base vocabulary should be represented as ordinary facts and loaded into the graph as part of bootstrap. It is not special because it bypasses the fact model; it is special because Poneglyph ships with it.

## Derivation model

Schema knowledge comes from two sources:

- base schema facts shipped with Poneglyph
- ordinary schema facts explicitly written by users or systems

`get_schema()` should not read `active_facts`. It should read the append-only fact history and construct a schema definition from facts that describe:

- namespaces
- kinds
- fields
- schema relationships between them

Important:

- base schema and user-defined schema are both represented as ordinary facts
- schema construction happens from immutable fact history
- schema construction does **not** depend on whether later data facts are currently active
- retracting data does not retract schema knowledge
- schema facts themselves are append-only too

This makes schema durable and monotonic.

## Storage model

The first iteration should not invent a separate magical schema model outside the graph. Schema is ordinary graph data.

To make `get_schema()` efficient, Poneglyph may maintain derived indexes or helper tables owned by fact storage.

Those helper structures may be implemented:

- as dedicated SQLite tables maintained transactionally during fact writes
- and as an in-memory equivalent for tests

But they are an optimization over schema facts, not a second source of truth.

Any schema helper structures should be updated in the same database transaction as fact writes, because:

- schema must be immediately available after a successful write
- MCP and agents may ask for schema right after stating facts
- losing schema updates while keeping fact writes would make discoverability inconsistent

The schema layer should also be initialized with the built-in base schema facts so they are queryable through the same API as user-defined schema.

### Suggested first helper tables

The exact schema is up to implementation, but a practical first version might maintain helper tables for:

- `schema_namespaces`
  - one row per namespace entity

- `schema_kinds`
  - one row per kind entity

- `schema_fields`
  - one row per field entity

- `schema_docs`
  - names and long-form docs for namespaces, kinds, and fields

- `schema_field_metadata`
  - domain
  - range
  - value type
  - cardinality
  - deprecated
  - identity

These remain derived indexes over ordinary schema facts.

## Schema API

`poneglyph` should expose a typed API, likely on `FactService` and `Poneglyph`, such as:

- `get_schema() -> PoneResult<SchemaDefinition>`

The returned schema definition should be:

- deterministic
- sorted
- compact enough for agent use
- expressive enough to help with Datalog authoring
- able to distinguish built-in schema vocabulary from user-defined schema where useful

The first version should at minimum include:

- built-in namespaces, kinds, and fields useful for authoring new schema
- namespaces
- kinds, with at least `name` and `doc`
- fields, with at least:
  - `name`
  - `doc`
  - `domain`
  - `range`
  - `valueType`
  - `cardinality`
  - `deprecated`
  - `identity`

Later versions may add:

- provenance
- schema aliases
- examples of data using a field
- explicit schema validation

## MCP surface

`poneglyph-mcp` should add:

- `getSchema`

At the `poneglyph` crate level, `get_schema()` should use the raw fact history to construct and return a typed schema definition.

At the MCP boundary, `getSchema` should return JSON Schema for the structured schema response so clients can validate and inspect the shape precisely.

This tool is intended to be called before `query`.

In the first iteration, tool descriptions should explicitly guide agents toward this usage:

1. call `getSchema`
2. inspect namespaces, kinds, fields, and examples
3. then write Datalog against that schema

## Error and usability requirements

The schema work should directly improve discoverability.

That means:

- MCP tool descriptions should mention `getSchema`
- URI parse errors should show example valid URIs when practical
- Datalog parse failures should keep contextual diagnostics
- schema responses should include examples and docs, not only bare field names

The system should optimize for first-query success by an LLM.

## Alternatives considered

### Derive schema from `active_facts`

Rejected.

This would cause schema knowledge to disappear when data is retracted or deleted, which is exactly the wrong property for agent discoverability.

### Model schema as an eventual projection

Rejected for the first version.

Schema should be available immediately after a successful write, not eventually.

### Ask agents to infer schema from entities or search

Rejected.

Those layers are incomplete, eventual, and not expressive enough for Datalog predicate discovery.

### Rely only on observed schema, with no base vocabulary

Rejected.

Observed schema alone does not tell an agent how to define new schema. Without a built-in vocabulary for namespaces, kinds, fields, and field metadata, the system would still be hard to extend consistently.

## Implementation plan

### Stage 0: Schema model RFD and vocabulary

- agree on the first schema-definition shape
- define the built-in base schema vocabulary
- define MCP discoverability goals

Exit criteria:

- this RFD is accepted

### Stage 1: Core schema types

- add `NamespaceSchema`, `KindSchema`, `FieldSchema`, `BaseSchema`, and `SchemaDefinition` to `poneglyph`
- add tests for deterministic schema assembly from ordinary schema facts

Exit criteria:

- core schema types compile
- unit tests cover schema assembly from ordinary schema facts

### Stage 2: Built-in schema bootstrap

- define the built-in schema facts shipped with Poneglyph
- load those schema facts during bootstrap
- make the built-in schema queryable through the same schema API as user-defined schema

Exit criteria:

- the base vocabulary is available in a fresh workspace with no user data
- tests prove that `get_schema()` returns useful built-in schema immediately after bootstrap

### Stage 3: Durable schema helpers

- extend fact storage with schema helper tables or in-memory equivalents as needed
- keep schema facts as ordinary facts
- ensure helper updates happen in the same transaction as fact writes

Exit criteria:

- writing schema facts updates schema synchronously
- retractions do not remove schema knowledge
- in-memory and SQLite backends behave the same

### Stage 4: Graph-derived schema read API

- add `get_schema()` to the appropriate runtime/service layer
- construct and return deterministic schema definitions from schema facts

Exit criteria:

- `Poneglyph::get_schema()` works
- property and integration tests cover repeated writes, duplicates, and retractions

### Stage 5: MCP schema tool

- add `getSchema`
- provide real JSON schema for its output shape
- update tool descriptions to encourage schema-first querying

Exit criteria:

- an MCP client can discover namespaces, kinds, and predicates before writing Datalog
- tool tests cover real usage patterns

### Stage 6: Feedback-driven UX tightening

- improve URI errors with examples
- improve query guidance in tool descriptions
- add example snippets to schema responses where useful

Exit criteria:

- schema-first MCP flow is meaningfully easier for another LLM to use

## Testing strategy

We should explicitly test all three levels: unit, property, and integration.

### Unit tests

- deterministic assembly into `SchemaDefinition`
- schema facts for namespaces, kinds, and fields are parsed correctly
- field metadata like `domain`, `range`, `valueType`, `cardinality`, `deprecated`, and `identity` are assembled correctly
- base schema bootstrap produces the expected built-in namespaces, kinds, and fields

### Property tests

- repeated assertion of the same schema fact does not duplicate schema entries
- retracting data does not remove schema entries
- writing schema facts in different batch shapes yields the same schema definition

### Integration tests

- a fresh workspace exposes the base schema vocabulary before any user facts are written
- `state_facts` immediately updates schema in both in-memory and SQLite stores
- `Poneglyph::get_schema()` reflects newly written namespaces, kinds, and fields immediately
- `getSchema` returns usable schema for an MCP client
- an MCP workflow of `getSchema -> query` works against real stored data

## Unresolved questions

- Should schema examples keep only the first seen example, the latest, or a bounded set of each?
- Should we expose provenance in the first version or defer it?
- Should `schema:field:valueType` and `schema:field:range` coexist, or should one subsume the other in the first iteration?
- Should the built-in base schema live entirely as seeded facts on disk, or partly as code-generated bootstrap data that is then persisted as facts?
