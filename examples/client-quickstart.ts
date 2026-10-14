import { createDatabase, type FactInput } from "../packages/poneglyph/src/index.js";

const url = process.env["PONEGLYPH_URL"];
if (url === undefined || url.length === 0) {
  throw new Error("Set PONEGLYPH_URL to the local or deployed Poneglyph Worker URL");
}

const db = createDatabase({ url });
const graph = db.defineGraph({ id: "release-assistant" });

const facts: readonly FactInput[] = [
  {
    source: "agent:release-assistant",
    entity: "app:service:auth-api",
    field: "app:service:blocked-by",
    value: { type: "reference", value: "app:task:rotate-key" },
  },
  {
    source: "agent:release-assistant",
    entity: "app:task:rotate-key",
    field: "app:task:status",
    value: { type: "text", value: "open" },
  },
  {
    source: "agent:release-assistant",
    entity: "app:task:rotate-key",
    field: "app:task:owner",
    value: { type: "reference", value: "app:person:ari" },
  },
];

// Reusing this id with the same facts makes rerunning this example idempotent.
const txId = await graph.stateFacts(facts, { txId: "release:quickstart-v1" });
const result = await graph.query(
  'app:service:blocked-by(Service, Task), app:task:status(Task, "open"), app:task:owner(Task, Owner)',
);

console.log(JSON.stringify({ txId, snapshotSeq: result.snapshotSeq, rows: result.rows }, null, 2));
