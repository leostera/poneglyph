# Poneglyph

Poneglyph is a local-first semantic graph database for agents.

The repository now has one product surface: a Rust `poneglyph` CLI that hosts a
local daemon and manages append-only facts, schemas, consolidated entities, and
Datafox-backed Datalog queries.

## Current workspace

- `crates/poneglyph-cli` — CLI/process host that builds the `poneglyph` binary.
- `crates/poneglyph-api` — local gRPC API/protobuf definitions and daemon service adapter.
- `crates/poneglyph-core` — core append-only fact store, schema/entity services,
  projections, query engine, runtime, and disk-backed workspace layout.
- `crates/poneglyph-db` — durable storage adapter boundary and staging point for the SQLite/Datafox split; see `docs/rfds/RFD0001-storage-crate-boundary.md` for the proposed boundary.
- `../datafox` — external sibling path dependency for Datalog parsing/evaluation.

Clone/check out Datafox next to this repository before building:

```sh
# sibling layout
# github.com/leostera/poneglyph
# github.com/leostera/datafox
cargo check --workspace
```

## CLI shape

```text
poneglyph server start|stop|restart|status|repair
poneglyph config list|get|set
poneglyph schema list|get|apply
poneglyph fact state|retract
poneglyph entity get
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
```

Start and inspect the daemon:

```sh
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
```

Get a consolidated entity:

```sh
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

See [`docs/rfds/RFD0000-cli-daemon-architecture.md`](docs/rfds/RFD0000-cli-daemon-architecture.md).

## Development

```sh
cargo check --workspace
cargo test --workspace
```
