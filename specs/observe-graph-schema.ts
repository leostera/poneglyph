import { defineSpec, message } from "@leostera/feynman";

type ValueTag = "null" | "text" | "number" | "boolean" | "bytes" | "reference" | "date" | "date_time" | "list" | "map";
type StoredFact = { field: string; valueTag: ValueTag; validFrom: number; validTo: number | null };
type Pair = { field: string; valueTag: ValueTag };
type ObservedField = { field: string; valueTags: ValueTag[] };

function observedFields(facts: StoredFact[], snapshotSeq: number): ObservedField[] {
  const byField = new Map<string, Set<ValueTag>>();
  for (const fact of facts) {
    if (fact.validFrom > snapshotSeq || (fact.validTo !== null && fact.validTo <= snapshotSeq)) continue;
    const tags = byField.get(fact.field) ?? new Set<ValueTag>();
    tags.add(fact.valueTag);
    byField.set(fact.field, tags);
  }
  return [...byField.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([field, tags]) => ({ field, valueTags: [...tags].sort() }));
}

export default defineSpec(
  "Observe the fields present in a Poneglyph graph",
  {
    description:
      "A graph has no registered field schema. A successful write publishes typed facts into active_facts; getSchema leases a read snapshot and derives the sorted field/value-tag inventory from those facts. This executable slice models one tree root, one unsplit shard, and the single-shard write boundary; production schema reads fan out across all 16 roots and every leaf.",
    messages: {
      WriteFact: message<{ field: string; valueTag: ValueTag; retraction: boolean }>({ name: "transact one fact", over: "https" }),
      AtomicWrite: message<{ field: string; valueTag: ValueTag; retraction: boolean; commitSeq: number }>({ name: "single-shard atomic write", over: "rpc" }),
      Applied: message<{ commitSeq: number }>({ name: "fact projection applied", over: "rpc", tone: "reply" }),
      Publish: message<{ commitSeq: number }>({ name: "publish the committed sequence", over: "rpc" }),
      Published: message<{ commitSeq: number }>({ name: "sequence visible", over: "rpc", tone: "reply" }),
      WriteReceipt: message<{ commitSeq: number }>({ name: "write committed", over: "https", tone: "reply" }),
      GetSchema: message<{}>({ name: "getSchema", over: "https" }),
      SchemaCall: message<{}>({ name: "POST /v1/graphs/:graph/schema", over: "http" }),
      AcquireRead: message<{}>({ name: "acquire subtree read lease", over: "rpc" }),
      ReadLease: message<{ readId: string; snapshotSeq: number; directoryEpoch: number }>({ name: "leased snapshot", over: "rpc", tone: "reply" }),
      ListLeaves: message<{ readId: string; snapshotSeq: number; directoryEpoch: number }>({ name: "list leaves at the leased directory epoch", over: "rpc" }),
      LeafList: message<{ readId: string; snapshotSeq: number; directoryEpoch: number; leaves: string[] }>({ name: "leaf addresses", over: "rpc", tone: "reply" }),
      ReadShardSchema: message<{ readId: string; snapshotSeq: number; directoryEpoch: number }>({ name: "read active field/tag pairs at snapshot", over: "rpc" }),
      ShardSchema: message<{ readId: string; snapshotSeq: number; directoryEpoch: number; pairs: Pair[] }>({ name: "distinct active field/tag pairs", over: "rpc", tone: "reply" }),
      ReleaseRead: message<{ readId: string }>({ name: "release subtree read lease", over: "rpc" }),
      Released: message<{ readId: string }>({ name: "read lease released", over: "rpc", tone: "reply" }),
      SchemaObservation: message<{ snapshotSeq: number; snapshotVector: { prefix: string; sequence: number; epoch: number }[]; fields: ObservedField[] }>({ name: "observed graph schema", over: "http", tone: "reply" }),
    },
  },
  (spec) => {
    const {
      WriteFact, AtomicWrite, Applied, Publish, Published, WriteReceipt,
      GetSchema, SchemaCall, AcquireRead, ReadLease, ListLeaves, LeafList,
      ReadShardSchema, ShardSchema, ReleaseRead, Released, SchemaObservation,
    } = spec.messages;

    spec.defineLimit({ name: "Independent tree roots in a graph", value: 16, unit: "roots", sources: ["packages/poneglyph/src/storage/forest.ts#TREE_PREFIXES"] });
    spec.defineLimit({ name: "Leaf fan-out per root", value: 256, unit: "leaves", sources: ["packages/poneglyph/src/storage/constants.ts#MAX_QUERY_SHARD_FANOUT"] });
    spec.defineLimit({ name: "Concurrent schema leaf readers", value: 16, unit: "readers", sources: ["packages/poneglyph/src/storage/coordinator-facade.ts:250-306"] });
    spec.defineLimit({ name: "Per-leaf schema scan phase timeout", value: 20_000, unit: "milliseconds", sources: ["packages/poneglyph/src/storage/constants.ts#QUERY_TIMEOUT_MS"] });
    spec.defineLimit({ name: "Read snapshot lease lifetime", value: 30_000, unit: "milliseconds", sources: ["packages/poneglyph/src/storage/constants.ts#READ_LEASE_TTL_MS"] });
    spec.defineLimit({ name: "Distinct field/tag pairs", value: 2_000, unit: "pairs", sources: ["packages/poneglyph/src/storage/constants.ts#MAX_QUERY_RESULTS"] });
    spec.defineLimit({ name: "Serialized response", value: 2_000_000, unit: "bytes", sources: ["packages/poneglyph/src/storage/constants.ts#MAX_QUERY_RESPONSE_BYTES"] });

    const outside = spec.defineZone({ name: "Application", description: "writes typed facts and asks what fields currently have data" });
    const service = spec.defineZone({ name: "Poneglyph Worker", description: "routes graph requests to its Durable Objects" });
    const storage = spec.defineZone({ name: "Graph Durable Objects", description: "ledger, snapshot owner, and shard projections" });

    const Application = spec.defineActor({
      name: "Application",
      description: "A typed Poneglyph client. It can write a field without registering that field first, then ask which fields are present.",
      zone: outside,
      singleton: true,
      initialState: () => ({ waitingForSchema: false, writing: false, lastSchema: null as null | { snapshotSeq: number; fields: ObservedField[] } }),
      display: { icon: "browser", status: (s) => s.waitingForSchema ? "observing fields" : s.lastSchema ? `${s.lastSchema.fields.length} observed field(s)` : "connected" },
      actions: {
        write: {
          label: "Write a fact",
          description: "Adds or retracts a typed assertion. A new field name is just data; it does not require schema registration.",
          inputs: {
            field: spec.defineInput(String, { examples: ["wiki:page:crew", "wiki:page:title"] }),
            valueTag: spec.defineInput(String, { examples: ["text", "reference"] }),
            retraction: spec.defineInput(Boolean, { examples: [false, true] }),
          },
          sources: ["packages/poneglyph/src/client.ts#HttpGraphClient.transact"],
          sends: [WriteFact],
          when: (s) => !s.writing,
          run: (s, input, ctx) => { s.writing = true; ctx.send(ctx.the(Worker), WriteFact, input as { field: string; valueTag: ValueTag; retraction: boolean }); },
        },
        getSchema: {
          label: "Get observed fields",
          description: "Requests the field/value-tag inventory at one leased subtree snapshot.",
          when: (s) => !s.waitingForSchema,
          sources: ["packages/poneglyph/src/client.ts#HttpGraphClient.getSchema"],
          sends: [GetSchema],
          run(s, _input, ctx) { s.waitingForSchema = true; s.lastSchema = null; ctx.send(ctx.the(Worker), GetSchema, {}); },
        },
      },
      transitions: {
        [WriteReceipt]: { description: "The application receives a receipt only after the single-shard write is published.", sources: ["packages/poneglyph/src/client.ts#HttpGraphClient.transact"], run(s) { s.writing = false; } },
        [SchemaObservation]: {
          description: "The client validates the complete observation and its snapshot vector before exposing it.",
          sources: ["packages/poneglyph/src/client.ts#HttpGraphClient.getSchema", "packages/poneglyph/src/domain/schema-observation.ts#parseGraphSchemaObservation"],
          run(s, message) { s.waitingForSchema = false; s.lastSchema = { snapshotSeq: message.snapshotSeq, fields: message.fields }; },
        },
      },
    });

    const Worker = spec.defineActor({
      name: "Poneglyph Worker",
      description: "Validates the graph route and dispatches the HTTP request to the graph coordinator facade.",
      zone: service,
      singleton: true,
      initialState: () => ({}),
      display: { icon: "cloud", status: () => "routing graph requests" },
      transitions: {
        [WriteFact]: { description: "Routes the transaction to the graph facade.", sources: ["packages/poneglyph/src/worker.ts:10-21"], sends: [WriteFact], run: (_s, m, ctx) => ctx.send(ctx.the(Facade), WriteFact, m) },
        [WriteReceipt]: { description: "Returns the successful transaction receipt to the typed client.", sources: ["packages/poneglyph/src/worker.ts:10-21"], sends: [WriteReceipt], run: (_s, m, ctx) => ctx.send(ctx.the(Application), WriteReceipt, m) },
        [GetSchema]: { description: "Routes the schema request to the graph facade.", sources: ["packages/poneglyph/src/worker.ts:10-21"], sends: [SchemaCall], run: (_s, _m, ctx) => ctx.send(ctx.the(Facade), SchemaCall, {}) },
        [SchemaObservation]: { description: "Returns the complete schema observation to the client.", sources: ["packages/poneglyph/src/worker.ts:10-21"], sends: [SchemaObservation], run: (_s, m, ctx) => ctx.send(ctx.the(Application), SchemaObservation, m) },
      },
    });

    const Facade = spec.defineActor({
      name: "GraphCoordinatorDO",
      description: "The per-graph facade. It reads a safe owner vector, leases a cut, traverses shard routing, scans every leaf, merges results, and releases the cut.",
      zone: storage,
      singleton: true,
      initialState: () => ({ readId: null as string | null, snapshotSeq: 0, directoryEpoch: 0, pairs: [] as Pair[] }),
      display: { icon: "cloud", status: (s) => s.readId ? "schema scan in progress" : "stateless facade" },
      transitions: {
        [WriteFact]: { description: "Delegates the public transaction to the graph's transaction ledger.", sources: ["packages/poneglyph/src/storage/coordinator-facade.ts:51-89"], sends: [WriteFact], run: (_s, m, ctx) => ctx.send(ctx.the(Ledger), WriteFact, m) },
        [WriteReceipt]: { description: "Returns the ledger's terminal write receipt.", sources: ["packages/poneglyph/src/storage/coordinator-facade.ts:51-89"], sends: [WriteReceipt], run: (_s, m, ctx) => ctx.send(ctx.the(Worker), WriteReceipt, m) },
        [SchemaCall]: {
          description: "Accepts only an empty schema request, captures the safe vector, and asks the tree owner for a read lease.",
          sources: ["packages/poneglyph/src/storage/coordinator-facade.ts:233-318"],
          sends: [AcquireRead],
          run(_s, _m, ctx) { ctx.send(ctx.the(Tree), AcquireRead, {}); },
        },
        [ReadLease]: {
          description: "Pins the exact sequence and directory epoch before looking up shard leaves.",
          sources: ["packages/poneglyph/src/storage/coordinator-facade.ts:446-479"],
          sends: [ListLeaves],
          run(s, m, ctx) { s.readId = m.readId; s.snapshotSeq = m.snapshotSeq; s.directoryEpoch = m.directoryEpoch; ctx.send(ctx.the(Shard), ListLeaves, m); },
        },
        [LeafList]: {
          description: "Starts the leaf scan using the identities from the leased snapshot.",
          sources: ["packages/poneglyph/src/storage/routing.ts#listShardLeaves"],
          sends: [ReadShardSchema],
          run(s, m, ctx) { ctx.send(ctx.the(Shard), ReadShardSchema, { readId: m.readId, snapshotSeq: s.snapshotSeq, directoryEpoch: s.directoryEpoch }); },
        },
        [ShardSchema]: {
          description: "Deduplicates field/tag pairs returned by the leaf, then releases the read lease before responding.",
          sources: ["packages/poneglyph/src/storage/coordinator-facade.ts:233-318"],
          sends: [ReleaseRead],
          run(s, m, ctx) { s.pairs = m.pairs; ctx.send(ctx.the(Tree), ReleaseRead, { readId: m.readId }); },
        },
        [Released]: {
          description: "Sorts the complete field and value-tag inventory, attaches the exact snapshot vector, and returns one response.",
          sources: ["packages/poneglyph/src/storage/coordinator-facade.ts:299-318"],
          sends: [SchemaObservation],
          run(s, _m, ctx) {
            const fields = observedFields(s.pairs.map((pair) => ({ ...pair, validFrom: 0, validTo: null })), s.snapshotSeq);
            ctx.send(ctx.the(Worker), SchemaObservation, { snapshotSeq: s.snapshotSeq, snapshotVector: [{ prefix: "0111", sequence: s.snapshotSeq, epoch: s.directoryEpoch }], fields });
            s.readId = null;
            s.pairs = [];
          },
        },
      },
    });

    const Ledger = spec.defineActor({
      name: "GraphLedgerDO",
      description: "For this model, the ledger has already planned and reserved a single-shard write; it asks the shard for an atomic decision, then publishes that decision through the tree owner.",
      zone: storage,
      singleton: true,
      initialState: () => ({ nextSeq: 1 }),
      display: { icon: "database", status: (s) => `next write at ${s.nextSeq}` },
      transitions: {
        [WriteFact]: { description: "Delegates the admitted single-participant batch to the shard's atomic path.", sources: ["packages/poneglyph/src/storage/transaction.ts:342-383"], sends: [AtomicWrite], run(s, m, ctx) { ctx.send(ctx.the(Shard), AtomicWrite, { ...m, commitSeq: s.nextSeq }); } },
        [Applied]: { description: "Publishes the shard's committed sequence only after the atomic witness is durable.", sources: ["packages/poneglyph/src/storage/transaction.ts:342-396"], sends: [Publish], run: (_s, m, ctx) => ctx.send(ctx.the(Tree), Publish, m) },
        [Published]: { description: "Returns success only after the owner sequence is visible.", sources: ["packages/poneglyph/src/storage/transaction.ts:342-383"], sends: [WriteReceipt], run(s, m, ctx) { s.nextSeq = m.commitSeq + 1; ctx.send(ctx.the(Facade), WriteReceipt, m); } },
      },
    });

    const Tree = spec.defineActor({
      name: "GraphTreeDO",
      description: "This representative owner supplies the visible sequence, directory epoch, and temporary MVCC read lease.",
      zone: storage,
      singleton: true,
      initialState: () => ({ visibleSeq: 0, directoryEpoch: 0, leases: [] as string[] }),
      durable: ["visibleSeq", "directoryEpoch", "leases"],
      display: { icon: "database", status: (s) => `visible ${s.visibleSeq}; ${s.leases.length} read lease(s)` },
      transitions: {
        [Publish]: { description: "Makes the applied single-shard commit visible to later snapshots.", sources: ["packages/poneglyph/src/storage/coordinator.ts:519-526"], sends: [Published], run(s, m, ctx) { s.visibleSeq = Math.max(s.visibleSeq, m.commitSeq); ctx.reply(Published, m); } },
        [AcquireRead]: { description: "Pins the current visible sequence and directory epoch with a read lease.", sources: ["packages/poneglyph/src/storage/coordinator.ts:329-353"], sends: [ReadLease], run(s, _m, ctx) { const readId = ctx.fresh("read"); s.leases.push(readId); ctx.reply(ReadLease, { readId, snapshotSeq: s.visibleSeq, directoryEpoch: s.directoryEpoch }); } },
        [ReleaseRead]: { description: "Releases the exact lease identity after the schema scan finishes.", sources: ["packages/poneglyph/src/storage/coordinator.ts:354-365"], sends: [Released], run(s, m, ctx) { s.leases = s.leases.filter((id) => id !== m.readId); ctx.reply(Released, m); } },
      },
    });

    const Shard = spec.defineActor({
      name: "GraphShardDO",
      description: "A representative unsplit leaf. Its active_facts projection is the schema observation's source; fact fields and value tags are not pre-registered.",
      zone: storage,
      singleton: true,
      initialState: () => ({ prefix: "0111", generation: 0, directoryEpoch: 0, activeFacts: [] as StoredFact[] }),
      durable: ["activeFacts"],
      display: { icon: "database", status: (s) => `${s.activeFacts.filter((fact) => fact.validTo === null).length} active fact(s)` },
      transitions: {
        [AtomicWrite]: { description: "Applies the committed assertion to active_facts; a retraction closes the matching active version instead of deleting history.", sources: ["packages/poneglyph/src/storage/shard.ts:143-190", "packages/poneglyph/src/storage/shard.ts:712-793"], sends: [Applied], run(s, m, ctx) {
          const current = s.activeFacts.find((fact) => fact.field === m.field && fact.valueTag === m.valueTag && fact.validTo === null);
          if (current) current.validTo = m.commitSeq;
          if (!m.retraction) s.activeFacts.push({ field: m.field, valueTag: m.valueTag, validFrom: m.commitSeq, validTo: null });
          ctx.reply(Applied, { commitSeq: m.commitSeq });
        } },
        [ListLeaves]: { description: "Returns the current leaf address at the captured directory epoch; this model has no split router.", sources: ["packages/poneglyph/src/storage/routing.ts#listShardLeaves"], sends: [LeafList], run(s, m, ctx) { ctx.reply(LeafList, { readId: m.readId, snapshotSeq: m.snapshotSeq, directoryEpoch: m.directoryEpoch, leaves: [s.prefix] }); } },
        [ReadShardSchema]: { description: "Groups active_facts by field and root FactValue tag at the requested sequence, excluding facts outside that MVCC interval.", sources: ["packages/poneglyph/src/storage/shard.ts:466-503"], sends: [ShardSchema], run(s, m, ctx) {
          const pairs = [...new Map(s.activeFacts
            .filter((fact) => fact.validFrom <= m.snapshotSeq && (fact.validTo === null || fact.validTo > m.snapshotSeq))
            .map((fact) => [`${fact.field}\u0000${fact.valueTag}`, { field: fact.field, valueTag: fact.valueTag }])).values()];
          ctx.reply(ShardSchema, { readId: m.readId, snapshotSeq: m.snapshotSeq, directoryEpoch: m.directoryEpoch, pairs });
        } },
      },
    });

    spec.defineProperties({
      schemaMatchesItsSnapshot: {
        description: "The returned inventory is exactly the distinct field/value-tag pairs active at the returned sequence, not a global or latest-after-the-fact schema.",
        always: (w) => {
          const result = w.the(Application).state.lastSchema;
          if (!result) return true;
          return JSON.stringify(result.fields) === JSON.stringify(observedFields(w.the(Shard).state.activeFacts, result.snapshotSeq));
        },
      },
      responseFollowsLeaseRelease: {
        description: "A completed observation is not returned while its snapshot lease remains held.",
        always: (w) => !w.the(Application).state.lastSchema || w.the(Tree).state.leases.length === 0,
      },
      noUnpublishedFactIsObserved: {
        description: "A field from an applied-but-not-yet-published fact cannot appear in a snapshot whose sequence is older than that fact.",
        always: (w) => {
          const result = w.the(Application).state.lastSchema;
          return !result || result.fields.every((field) => w.the(Shard).state.activeFacts.some((fact) => fact.field === field.field && fact.validFrom <= result.snapshotSeq));
        },
      },
    });

    spec.defineScenario({
      name: "Write a new field, then observe it",
      description: "A producer adds a field/value tag by writing a fact. Poneglyph has no pack loader or schema registry in this flow; the next getSchema derives the inventory from active_facts at a leased snapshot.",
      run(s) {
        const app = s.the(Application);
        s.act(app, "write", { field: "wiki:page:crew", valueTag: "reference", retraction: false });
        s.settle();
        s.act(app, "getSchema");
        s.settle();
      },
    });
    spec.defineScenario({
      name: "A retraction removes the last observed type",
      description: "Retracting the only active assertion closes its MVCC interval. A later snapshot no longer reports that field/tag pair, while the historical fact is not deleted.",
      run(s) {
        const app = s.the(Application);
        s.act(app, "write", { field: "wiki:page:crew", valueTag: "reference", retraction: false });
        s.settle();
        s.act(app, "write", { field: "wiki:page:crew", valueTag: "reference", retraction: true });
        s.settle();
        s.act(app, "getSchema");
        s.settle();
      },
    });

    return { Application, Worker, Facade, Ledger, Tree, Shard };
  },
);
