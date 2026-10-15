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

A stored fact also has a storage-assigned `factId`, the committing transaction ID (`txId`), and `statedAt`. The coordinator assigns `statedAt` while admitting the transaction; it is a UTC record of when Poneglyph stated the fact, not a timestamp from the source material. Statement times are advanced to remain increasing, and facts in a batch receive successive millisecond values.

The fact log is append-only. A correction adds a retraction and a replacement assertion; it does not edit the earlier fact.

### Fields and URI conventions

`wiki:page:title` is a field URI: it names the property "page title." In Datalog notation, the field URI is written as the relation name:

```text
wiki:page:title(Page, "Monkey D. Luffy")
```

The URI's first component is its scheme (`wiki` here); the remaining text is an opaque identifier to Poneglyph. An application may give those pieces meaning by convention—for example, using `spotify:` or `onepiece:` for its own vocabulary—but Poneglyph does not interpret or group identifiers by those prefixes. In `wiki:onepiece:page:...`, `wiki` is the scheme; the application may define meanings for the rest.

You choose field URIs and should document and reuse them consistently. Poneglyph validates that a field is a URI and that a value is a supported typed value, but it does not require fields to be registered or enforce a field-specific type. The playground's `describe_dataset` inventory is guidance about its known predicates, not schema enforcement.

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

const txId = await graph.stateFacts([draft]);
```

`stateFacts` sends the draft list as one write and returns the transaction ID after success. If omitted, the client generates a URI-style ID before sending; the current API also permits callers to supply one. The ID names the whole batch, but an ID by itself is not proof of commit: on successful return, `stateFacts` has received a committed outcome, while a write error may carry the ID even when delivery is unknown. `graph.transact(...)` returns the same successful outcome with the ID, commit sequence, and `committed` status. Reusing an ID with the same facts refers to the same transaction; reusing it with different facts is a conflict. If delivery is uncertain, preserve the ID and exact facts and reconcile that transaction rather than inventing a replacement ID.

### Graph scope and coordination

A graph ID selects an isolated fact namespace. `db.defineGraph({ id })` creates a local client handle for that namespace; it does not register a SQL-style schema. A graph is roughly like a SQL database as a boundary, but it has no catalog of tables and columns: facts use field URIs. Separate graphs can isolate tenants, environments, or lifecycles, but Poneglyph does not join queries or transactions across them.

The graph coordinator is persistent control for that graph's routing and visibility state, not the place where its facts are stored. The fact data lives in the graph's data-owning shards.
