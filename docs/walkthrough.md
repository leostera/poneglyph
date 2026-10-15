# Poneglyph walkthrough

An interactive, incremental explanation of how a fact moves through Poneglyph. This is a learning aid, not a replacement for the implementation contracts in [RFD0004](rfds/RFD0004-expandable-cloudflare-sharding.md) and [RFD0005](rfds/RFD0005-write-path-experiment.md).

## Step 1: Facts and identity

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

The entity is a URI, for example `wiki:onepiece:page:Monkey%20D.%20Luffy`. The title text `"Monkey D. Luffy"` is a separate value in a fact about that entity. These identifiers use Poneglyph's URI scheme; they are not necessarily HTTP addresses.

The fact log is append-only. A correction adds a retraction and a replacement assertion; it does not edit the earlier fact. The write input is a draft. A stored fact also has a storage-assigned `factId`, the committing transaction ID (`txId`), and `statedAt`. The coordinator assigns `statedAt` while admitting the transaction; it is a UTC record of when Poneglyph stated the fact, not a timestamp from the source material. Statement times are advanced to remain increasing, and facts in a batch receive successive millisecond values.

## Step 2: Routing an entity to a shard

Poneglyph hashes the graph ID together with the canonical entity URI to get a stable virtual key, then follows that key through a sparse binary prefix tree to an active leaf shard. All facts for one entity stay on the same leaf. If a leaf splits, physical placement changes but the entity URI and fact meaning do not.

A relation with a bound entity can follow the tree to that entity's owner. A field- or value-only scan does not know which owners contain matches, so it fans out. The One Piece graph had 16 active leaves in the observed snapshot. Broad scans are capped at 256 leaves; that is a query fan-out budget, not a global maximum number of shards.

*Next: how a write is coordinated across its owner shards and becomes visible.*
