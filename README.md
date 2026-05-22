<p align="center">
  <h1>
    <img src="assets/poneglyph.svg#svgView(viewBox(240,240,560,560))" alt="Poneglyph" width="64" height="64">
    Poneglyph
  </h1>
</p>

Poneglyph is an embeddable semantic knowledge graph database for building agent memory,
knowledge-workflow, and domain graph applications.

It stores durable knowledge as append-only facts, derives current graph state from those facts,
and answers semantic queries with a Datafox-backed Datalog engine. The default local runtime uses a
custom LSM fact store tuned for graph predicate scans, plus local projection stores for entities and
search.

## How Poneglyph works

Poneglyph is built around one rule: facts are the source of truth.

A fact states that an entity has a field with a value:

```text
memory:item:first-note  memory:title  "First note"
```

Facts are append-only. Updates and deletes are represented by new facts, including retractions,
rather than mutating old rows in place. This gives Poneglyph a durable audit log and makes derived
views replayable.

At runtime, Poneglyph maintains:

1. **Fact log** — every asserted or retracted fact, stored durably and append-only.
2. **Active graph** — the latest visible assertions after applying retractions.
3. **Entity projection** — convenient entity-shaped views derived from active facts.
4. **Search projection** — Tantivy-backed text search over projected entities.
5. **Datalog query engine** — semantic joins over the active graph via Datafox.

The active graph is optimized for Datafox `FactRequest` access patterns. A query predicate like:

```text
wiki:page:title(Page, Title)
```

maps directly to a prefix scan over the local active index for `wiki:page:title`. More selective
patterns, such as an entity-bound or value-bound predicate, map to narrower active-index scans.

## Local storage

The default local fact backend is a Poneglyph-specific LSM store:

- append-only WAL for recent writes;
- immutable SST segments for flushed data;
- manifest edit log for crash-safe segment publishing;
- active indexes for field/entity/value query shapes;
- compact binary active-fact encoding;
- decoded active-fact cache for repeated semantic queries;
- configurable compaction, cache, and SST read policies.

SQLite remains available as a reference implementation for correctness and comparison, but the
standard local runtime opens the LSM fact store by default.

## Embedding quickstart

Downstream daemons usually depend on:

- `poneglyph` for the core fact model, runtime traits, and query API;
- `poneglyph-local` for disk-backed local storage assembly;
- optionally `poneglyph-api` for the local gRPC service boundary.

```rust,no_run
use poneglyph::{Value, Workspace, fact, uri};
use poneglyph_local::open_workspace;

#[tokio::main]
async fn main() -> poneglyph::PoneResult<()> {
    let runtime = open_workspace(Workspace::at("./agent-memory.poneglyph")).await?;

    runtime
        .state_facts(vec![fact!(
            uri!("memory:item:first-note"),
            uri!("memory:title"),
            Value::text("First note")
        )])
        .await?;

    let rows = runtime
        .query_str(r#"memory:title(Item, "First note")"#)
        .await?;

    println!("matched {} memory item(s)", rows.len());
    Ok(())
}
```

## Query example

Poneglyph queries are semantic joins over facts. For example, a small One Piece knowledge graph can
ask for crews, captains, and seconds-in-command:

```text
wiki:crew:captain(Crew, Captain),
wiki:crew:second(Crew, Second),
wiki:page:title(Crew, CrewName),
wiki:page:title(Captain, CaptainName),
wiki:page:title(Second, SecondName)
```

Because every predicate is a graph fact, the same model works for agent memories, documents,
calendar events, emails, code references, domain entities, and application-specific knowledge.

## Benchmarks

The current large semantic-query benchmark uses a cached One Piece wiki export as realistic graph
input. The fixture is downloaded locally into `tests/fixtures/cache/` and is not committed to the
repository.

The benchmark ingests 50,000 wiki pages, derives page/category/link/domain facts, then runs 20
semantic Datafox queries over the LSM-backed active graph. The query set includes:

- crews with captains and seconds-in-command;
- islands with leaders;
- a Joy Boy → Luffy lore connection chain;
- characters with `D.` in their name, filtered to character pages before applying string matching.

Recent local result:

```text
50,000 pages
306,278 derived facts
20 semantic queries in ~887 ms
~44 ms/query
```

Command:

```sh
PONEGLYPH_ONEPIECE_MAX_PAGES=50000 \
PONEGLYPH_ONEPIECE_QUERIES=20 \
PONEGLYPH_ONEPIECE_BATCH=10000 \
cargo test -p poneglyph-local --test stress \
  local_lsm_backend_onepiece_wiki_query_stress \
  --locked -- --ignored --nocapture
```

For small warm-query runs over 5,000 pages, the same LSM path is currently in the single-digit
milliseconds per query range on the development machine.
