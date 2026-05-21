# Poneglyph

Poneglyph is a local-first semantic graph database for agents.

The repository now has one product surface: a Rust `poneglyph` CLI that hosts a
local daemon and manages append-only facts, schemas, consolidated entities, and
Datafox-backed Datalog queries.

## Current workspace

- `crates/poneglyph-cli` — CLI/process host that builds the `poneglyph` binary.
- `crates/poneglyph-api` — local gRPC API/protobuf definitions and daemon service adapter. Typed protobuf RPCs are the primary path for semantic CLI operations; legacy JSON RPCs remain only as compatibility shims.
- `crates/poneglyph-core` — core append-only fact store, schema/entity services,
  projections, query engine, runtime, and disk-backed workspace layout.
- `crates/poneglyph-db` — durable storage adapter boundary and staging point for the SQLite/Datafox split; see `docs/rfds/RFD0001-storage-crate-boundary.md` for the proposed boundary.
- `../datafox` — external sibling path dependency for Datalog parsing/evaluation.

## Review status

The Rust reset is intentionally narrow and reviewable:

- the user-facing binary is only `poneglyph`;
- semantic CLI operations prefer typed protobuf daemon RPCs and retain direct
  workspace fallback when the daemon is offline;
- legacy JSON semantic RPCs remain only as compatibility shims for one migration
  window and are covered by parity tests against the typed RPCs;
- `poneglyph-db` is the preferred durable storage boundary, while physical
  SQLite/search module movement from `poneglyph-core` is explicitly deferred in
  RFD0001 until the next storage architecture decision; and
- the local daemon transport is localhost TCP for now, with Unix-domain sockets
  documented as a future lifecycle/cleanup improvement in RFD0000.

Clone/check out Datafox next to this repository before building:

```sh
# sibling layout
# github.com/leostera/poneglyph
# github.com/leostera/datafox
cargo check --workspace
```

## CLI shape

```text
poneglyph --help
poneglyph --version
poneglyph server start|stop|restart|status|repair
poneglyph config list|get|set
poneglyph schema list|get|apply
poneglyph fact state|retract|list
poneglyph entity get|list|search
poneglyph query <datalog>
```

Config commands operate directly on the workspace config file. Schema, fact,
query, and entity commands try the daemon gRPC API first and fall back to direct
workspace access when the daemon is offline. `poneglyph server start` exposes the
gRPC API over localhost TCP (`rpc.bind_addr`, default `127.0.0.1:5747`).

## Common workflows

Use an isolated workspace while experimenting:

```sh
export PONE=./.poneglyph-dev
poneglyph --workspace "$PONE" config set poneglyph.log_level off
poneglyph --workspace "$PONE" config get poneglyph.log_level --json
poneglyph --workspace "$PONE" config set rpc.bind_addr 127.0.0.1:50051 --json
```

Start and inspect the daemon:

```sh
poneglyph --workspace "$PONE" server repair --json
poneglyph --workspace "$PONE" server start
poneglyph --workspace "$PONE" server status
poneglyph --workspace "$PONE" server stop
```

State a fact. The CLI prints both the transaction id and the fact id so the fact
can be retracted later.

```sh
poneglyph --workspace "$PONE" fact state \
  spotify:album:2112 \
  spotify:displayName \
  2112
poneglyph --workspace "$PONE" fact list --entity spotify:album:2112
poneglyph --workspace "$PONE" fact list --entity spotify:album:2112 --limit 25 --offset 25
poneglyph --workspace "$PONE" fact list --entity spotify:album:2112 --active
poneglyph --workspace "$PONE" fact list --tx poneglyph:tx:...
poneglyph --workspace "$PONE" fact list --entity spotify:album:2112 --json

# machine-readable outcome
poneglyph --workspace "$PONE" fact state spotify:album:signals spotify:displayName Signals --json
```

Query the active graph with Datalog. Plain output prints one `row` line with
variable bindings; `--json` preserves the full machine-readable substitution
array.

```sh
poneglyph --workspace "$PONE" query 'spotify:displayName(Album, "2112")'
# row	Album="spotify:album:2112"
poneglyph --workspace "$PONE" query 'spotify:displayName(Album, "2112")' --json
```

Retract by fact id. This appends a retraction fact; it does not delete or mutate
the original assertion.

```sh
poneglyph --workspace "$PONE" fact retract --fact poneglyph:fact:...
poneglyph --workspace "$PONE" fact retract --fact poneglyph:fact:... --json
```

Retraction output includes the new retraction fact id and, for `--fact`, the
`retracted_fact_id` that was targeted.

Get consolidated entities:

```sh
poneglyph --workspace "$PONE" entity list
poneglyph --workspace "$PONE" entity list --limit 25 --offset 25
poneglyph --workspace "$PONE" entity list --json
poneglyph --workspace "$PONE" entity search "2112"
poneglyph --workspace "$PONE" entity search "2112" --limit 5
poneglyph --workspace "$PONE" entity search "2112" --json
poneglyph --workspace "$PONE" entity get spotify:album:2112
# machine-readable full entity
poneglyph --workspace "$PONE" entity get spotify:album:2112 --json
```

Apply schema from a JSON or TOML `SchemaDefinition` file:

```sh
poneglyph --workspace "$PONE" schema apply ./schema.json
poneglyph --workspace "$PONE" schema apply ./schema.json --json
poneglyph --workspace "$PONE" schema list
poneglyph --workspace "$PONE" schema list --json
poneglyph --workspace "$PONE" schema get music:released
poneglyph --workspace "$PONE" schema get music:released --json
```

Typed CLI values:

- bare values are text (`2112` is stored as text)
- `num:2112` stores a number
- `bool:true` stores a boolean
- `ref:spotify:artist:rush` stores a reference
- full tagged `Value` JSON is also accepted

## Architecture

See [`docs/rfds/RFD0000-cli-daemon-architecture.md`](docs/rfds/RFD0000-cli-daemon-architecture.md),
[`docs/rfds/RFD0001-storage-crate-boundary.md`](docs/rfds/RFD0001-storage-crate-boundary.md),
and [`docs/review-readiness.md`](docs/review-readiness.md).

## Development

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

CI expects this repository and Datafox to be checked out as siblings, matching
the local `../datafox` path dependency layout. The protobuf compiler (`protoc`)
is also required because `poneglyph-api` generates tonic/prost bindings at build
time.
