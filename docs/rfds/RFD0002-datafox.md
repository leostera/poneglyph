# RFD0002 - Datafox Query Engine

- Feature Name: `datafox-query-engine`
- Start Date: `2026-03-13`
- RFD PR: `TBD`
- Poneglyph Issue: `TBD`

## Summary
[summary]: #summary

Poneglyph will introduce a new Rust crate named `datafox` as a standalone Datalog parser and streaming query engine. `datafox` will replace the current ad hoc `datafrog` spike as the primary path toward graph querying.

`datafox` will:

- parse Datalog query strings into a typed AST
- execute read-only queries against a snapshot-oriented storage interface
- stream query results instead of requiring the full query universe to be materialized in memory
- keep parsing, planning, storage access, unification, and evaluation errors typed and contextual

In the first iteration, `datafox` is query-only. It will support:

- single-goal queries
- multi-goal conjunctive queries
- snapshot-based reads
- streaming substitutions / result bindings

It will not initially support:

- rule evaluation
- recursive derivation rules
- negation
- builtins
- query optimization beyond simple clause ordering

Poneglyph will later integrate `datafox` by implementing the `datafox` storage interface over its strongly consistent active graph snapshot.

## Motivation
[motivation]: #motivation

The current `datafrog` spike proved that the core query semantics are workable:

- exact field lookup
- same-entity joins
- one-hop and multi-hop reference traversal
- recursive reachability over an in-memory active relation

That spike was useful, but it also exposed a structural problem: `datafrog` evaluates over in-memory `Relation`s. That makes it a poor direct fit for Poneglyph's long-term query path, where the active graph may contain millions of current facts and queries should be driven by indexed scans over relevant slices of the graph rather than by preloading a closed world into memory.

At the same time, the vendored OCaml prototype in `3rdparty/datalog-ml` and `3rdparty/poneglyph-ml` already established a more appropriate architecture:

- query strings are parsed into a small AST
- evaluation happens over a read-only snapshot `Universe`
- storage provides streaming pattern-matching reads
- multi-goal queries are executed as streaming joins over storage-backed iterators

This RFD adopts that architecture for Rust.

The goal is not to port OCaml module-for-module mechanically. The goal is to preserve the correct boundaries:

- parser and AST are query-language concerns
- unification and substitution are evaluator concerns
- storage is a pluggable snapshot interface
- Poneglyph remains the owner of the active graph and transaction semantics

## Guide-level explanation
[guide-level-explanation]: #guide-level-explanation

`datafox` is a standalone crate that knows nothing about SQLite, Poneglyph entities, Tantivy, or projections.

It defines a small Datalog query language and a storage boundary.

At a high level, the flow looks like this:

1. A user or application submits a Datalog query string.
2. `datafox` parses the query string into a CST and then a typed AST.
3. A `Universe` is created over a snapshot-oriented storage backend.
4. The evaluator asks storage for tuples matching each query clause.
5. Matching tuples are unified into substitutions.
6. The final substitutions are returned as a stream.

The key point is that `datafox` does not require the storage backend to materialize the whole graph in memory. Storage should be able to serve:

- predicate-specific scans
- pattern-constrained scans
- snapshot-isolated reads

For Poneglyph, that means `datafox` will query the strongly consistent active graph, not the raw append-only fact log and not the eventual entity projection layer.

### Example

Given active facts logically equivalent to:

- `spotify:displayName(spotify:album:2112, "2112")`
- `spotify:byArtist(spotify:album:2112, spotify:artist:rush)`
- `spotify:displayName(spotify:artist:rush, "Rush")`

A query might look like:

```prolog
spotify:byArtist(Album, Artist),
spotify:displayName(Artist, "Rush")
```

`datafox` would:

1. parse that query
2. ask storage for matches to `spotify:byArtist(_, _)`
3. unify each result into `{ Album = ..., Artist = ... }`
4. instantiate the second clause with the known `Artist`
5. stream only the substitutions that satisfy both clauses

The intended user-facing property is that the first matching result can appear quickly, without waiting for all current facts to be loaded into memory.

## Reference-level explanation
[reference-level-explanation]: #reference-level-explanation

## Crate boundary

A new workspace crate will be added:

- `crates/datafox`

It will be a general-purpose Datalog parser and streaming evaluator crate. `poneglyph` will depend on it, not the other way around.

## Initial module structure

The initial Rust module structure should mirror the OCaml architecture, not necessarily its exact filenames:

- `ast`
- `term`
- `value`
- `parser`
- `diagnostic`
- `substitution`
- `unify`
- `storage`
- `universe`
- `evaluator`

Optional internal modules may be added as needed, but these are the primary conceptual boundaries.

## Storage interface

`datafox` should define a query-only storage interface built around snapshot reads and pattern matching.

The exact Rust types may evolve, but the core capability should be equivalent to:

- `get_facts_matching(predicate, pattern)`

Where:

- `predicate` identifies the relation being queried
- `pattern` contains constants or wildcards
- results are streamed
- snapshot isolation is the responsibility of the storage backend or universe handle

The important architectural consequence is that query execution is clause-driven and storage-driven, not universe-materialization-driven.

## Query model

The first query model should support:

- `Single(atom)`
- `Multi(clause list)`

And clauses should initially support:

- positive atoms only

Negation and builtins are explicitly deferred.

The first implementation should treat recursive rules as out of scope. Query-only evaluation is enough to make the first end-to-end graph query path real.

## Universe

`Universe` should be a thin wrapper around a storage snapshot. It should not own derivation state.

This is important for Poneglyph:

- facts remain the durable truth
- the active graph is the strongly consistent query-side state
- `datafox` is a query layer over that state

`Universe` is therefore an evaluation boundary, not a materialization system.

## Error model

`datafox` must use typed errors and diagnostics throughout. Stringly errors are not acceptable for this subsystem.

At minimum, the public API should preserve contextual errors for:

- lexing errors
- parse errors
- CST-to-AST conversion errors
- arity mismatches
- unification failures where context is needed
- unsupported query features
- storage failures
- evaluation failures

Parse errors should include:

- source location when available
- the offending token or source slice when practical
- a human-readable explanation of what was expected

Evaluation errors should preserve:

- the failing clause or predicate when available
- whether the failure came from storage, substitution, or evaluator logic

## Why not just use datafrog?

`datafrog` remains useful as a semantic spike and possibly as an internal implementation technique for some bounded query cases.

It is not, by itself, a sufficient public query engine for Poneglyph because:

- it expects in-memory relations
- it does not provide a Datalog parser
- it does not define the storage/query boundary Poneglyph needs
- it does not naturally express streaming clause-driven evaluation over external storage

`datafox` is intended to solve the missing layers above that.

## Implementation plan

`datafox` should be built in explicit stages.

### Stage 0: Crate scaffold

- add `crates/datafox` to the workspace
- set up typed errors and diagnostics from the start
- add a small test harness and example in-memory storage backend

Exit criteria:

- crate builds
- error types and module boundaries are in place

### Stage 1: Terms, values, AST

- port or reimplement `Term`, `Value`, `Atom`, `Clause`, and `Query`
- support only the subset needed for query-only execution
- ensure formatting and debug output are readable

Exit criteria:

- AST constructors exist
- AST round-trip and shape tests pass

### Stage 2: Parser and diagnostics

- port the OCaml query parser or reimplement it in Rust
- parse single-goal and multi-goal queries
- return rich diagnostics on malformed input

Exit criteria:

- valid queries parse into the expected AST
- invalid queries produce contextual diagnostics

### Stage 3: Substitutions and unification

- implement variable bindings
- implement matching atoms against concrete tuples
- implement streaming tuple-to-substitution matching

Exit criteria:

- unification tests pass
- substitution extension and conflict cases are covered

### Stage 4: Storage and universe

- define the storage trait
- implement an in-memory test backend
- define snapshot-oriented `Universe`

Exit criteria:

- evaluator can run against test storage without Poneglyph integration
- storage errors are surfaced with context

### Stage 5: Streaming evaluator

- implement single-goal query execution
- implement multi-goal conjunctive query execution
- keep execution streaming
- use simple clause ordering first, without a planner

Exit criteria:

- first result is produced without materializing all results
- multi-goal joins pass semantic tests

### Stage 6: Poneglyph integration

- implement the `datafox` storage trait over Poneglyph's active graph snapshot
- add `QueryEngine` in `poneglyph` as a thin wrapper over `datafox`
- keep the integration boundary narrow so the backend can evolve independently

Exit criteria:

- state facts in `poneglyph`
- run a Datalog query through `datafox`
- receive correct results against the active graph snapshot

### Stage 7: Performance and ergonomics review

- inspect which query patterns are too expensive
- add targeted scan APIs or indexes only where proven necessary
- evaluate whether some bounded query cases should still compile to `datafrog`

Exit criteria:

- we know whether `datafox` is sufficient as the long-term engine
- or we have concrete evidence for replacing parts of it

## Testing strategy

`datafox` should be tested at three levels from the beginning.

### Unit tests

Unit tests should cover:

- tokenization and parser edge cases
- AST construction
- substitution extension and conflicts
- atom/tuple matching
- clause ordering behavior
- error formatting for malformed queries

### Property tests

Property tests should cover:

- parser stability on generated valid inputs where practical
- unification invariants
- substitution application invariants
- equivalence between streamed and materialized evaluation for small universes
- deterministic result ordering for the same snapshot

### Integration tests

Integration tests should cover:

- in-memory `datafox` storage backend
- end-to-end parsing plus evaluation
- Poneglyph-backed active graph snapshots
- real query strings over realistic URIs and values

## Error-quality requirements

Error handling is a first-class acceptance criterion for `datafox`.

Every stage should preserve enough context to debug failures without guesswork.

We should test for:

- invalid syntax with correct location reporting
- unsupported feature use with explicit messages
- arity mismatch errors that identify the predicate and expected arity
- storage failures that preserve the underlying source error
- evaluation failures that identify which query clause was being processed

The goal is that when a query fails, the caller can tell whether the problem is:

- invalid source text
- invalid AST shape
- unsupported language feature
- storage backend failure
- evaluator logic failure

without reading internal logs or stepping through a debugger.

## Consequences

Positive consequences:

- Poneglyph gets a proper query-language boundary instead of ad hoc query shapes
- query execution can remain storage-driven and stream-oriented
- the Datalog subsystem becomes reusable outside Poneglyph
- parser and evaluator errors can be tested directly

Negative consequences:

- this adds a new crate and therefore a new maintenance surface
- initial delivery will take longer than continuing the `datafrog` spike
- we will temporarily have both `datafrog` experiments and `datafox` design work in the repository

## Alternatives considered

### Continue building directly on datafrog

Rejected for now because it leaves the wrong public boundary:

- no parser
- no Datalog query model
- no storage trait
- poor fit for large active graphs when modeled as preloaded in-memory relations

### Remove retractions or simplify the fact model for query execution

Rejected.

Poneglyph still needs explicit fact-layer retractions. The right solution is to query a strongly consistent active graph snapshot, not to weaken the fact model for convenience.

### Query over consolidated entities instead of active facts

Rejected for the core Datalog path.

Entities are eventual and intentionally lossy relative to the fact log. The strongly consistent query path should run over the active graph maintained synchronously with fact writes.

## Unresolved questions

- Should `datafox` define its own generic `Value`, or should it allow host crates to plug in a value type?
- Should query result ordering be explicitly part of the engine contract or left to the storage backend?
- At what point should simple clause reordering or a real planner be introduced?
- Should recursive rules be added to `datafox`, or should Poneglyph reserve recursion for a later engine iteration?
- How much of the OCaml parser should be ported directly versus reimplemented idiomatically in Rust?

## Future possibilities

- recursive rule evaluation
- negation and builtins
- query planning and selectivity-based clause ordering
- external-memory evaluation strategies
- optional compilation of bounded query fragments into `datafrog`
- richer result types than substitutions alone
