// All page copy and links in one place. Keep claims aligned with the README and
// RFDs: Poneglyph is an experimental 0.1.0 prototype, not a hosted service.

export const LINKS = {
  github: "https://github.com/leostera/poneglyph",
  playground: "https://onepiece.poneglyph.dev",
  mcp: "https://onepiece.poneglyph.dev/mcp",
  walkthrough: "https://github.com/leostera/poneglyph/blob/main/docs/walkthrough.md",
  rfds: "https://github.com/leostera/poneglyph/tree/main/docs/rfds",
  client: "https://github.com/leostera/poneglyph/tree/main/packages/poneglyph",
  quickstart: "https://github.com/leostera/poneglyph/tree/main/examples/client-quickstart",
} as const;

export const VERSION = "0.1.0";

export const BENEFITS = [
  { title: "Nothing to operate", body: "No servers, clusters or capacity planning. You deploy a Worker to your Cloudflare account and Cloudflare runs everything underneath." },
  { title: "Storage grows on its own", body: "Facts are spread across many Durable Objects. When a shard fills up it splits in two, so a graph keeps growing without a migration." },
  { title: "Writes run in parallel", body: "Writes to different entities run side by side. Only writes that touch the same entity take turns." },
  { title: "Lookups go straight to the data", body: "A query that names an entity or a value reads only the shards that hold it. Wider queries read their shards in parallel." },
  { title: "Never half-written", body: "A write is saved completely or not at all, even across many entities and shards. Queries never see half of one." },
  { title: "Nothing is overwritten", body: "Every fact records who said it. To correct one, retract it and add a new one; the history stays." },
  { title: "Retries are safe", body: "Lost the response? Send the same request again and you get the original result, not a duplicate." },
] as const;

// The "How it works" walkthrough: one small graph, built up in three steps.
export const HOW = [
  {
    id: "model",
    label: "Model",
    title: "Model your data as a graph",
    body: "Your data is things and the connections between them: a service, the task blocking it, the person who owns that task. Each thing is an entity. There's no schema to declare up front; add a new field whenever you need one.",
  },
  {
    id: "write",
    label: "Write",
    title: "Build it out of facts",
    body: "You create and change entities by writing facts. Each fact is one connection in the graph: an entity, a field and a value, plus who said it. Facts written together are saved together, or not at all.",
    code: `await graph.transact([
  { entity: "app:service:auth-api",           // 1
    field:  "app:service:blocked-by",
    value:  { type: "reference", value: "app:task:rotate-key" },
    source: "agent:release-bot" },
  { entity: "app:task:rotate-key",            // 2
    field:  "app:task:status",
    value:  { type: "text", value: "open" },
    source: "agent:release-bot" },
  { entity: "app:task:rotate-key",            // 3
    field:  "app:task:owner",
    value:  { type: "reference", value: "app:person:ari" },
    source: "agent:release-bot" },
]);`,
  },
  {
    id: "query",
    label: "Query",
    title: "Ask questions across it",
    body: "Queries follow the connections. Capitalized words are variables, and using one twice joins two facts: here Task links the blocked service to its owner. You get back every match.",
    query: `app:service:blocked-by(Service, Task),
app:task:status(Task, "open"),
app:task:owner(Task, Owner)`,
    result: `[{ Service: "app:service:auth-api",
   Task:    "app:task:rotate-key",
   Owner:   "app:person:ari" }]`,
  },
] as const;

export const QUICKSTART = {
  run: `git clone https://github.com/leostera/poneglyph
cd poneglyph
bun install --frozen-lockfile
bun run dev            # serves on http://127.0.0.1:5173`,
  client: `import { createDatabase, type FactInput } from "@leostera/poneglyph";

const graph = createDatabase({ url: process.env.PONEGLYPH_URL! })
  .defineGraph({ id: "release-assistant" });

const facts: readonly FactInput[] = [
  { source: "agent:release-assistant", entity: "app:service:auth-api",
    field: "app:service:blocked-by", value: { type: "reference", value: "app:task:rotate-key" } },
  { source: "agent:release-assistant", entity: "app:task:rotate-key",
    field: "app:task:status", value: { type: "text", value: "open" } },
];

// Reusing the token makes retries safe.
const { txId } = await graph.transact(facts, { clientRequestToken: "release:seed-001" });

const { rows } = await graph.query(
  'app:service:blocked-by(Service, Task), app:task:status(Task, "open")',
);`,
  example: `PONEGLYPH_URL=http://127.0.0.1:5173 \\
  bun run --cwd examples/client-quickstart run`,
} as const;

export const MCP_CONFIG = `{
  "mcpServers": {
    "poneglyph-onepiece": {
      "url": "${LINKS.mcp}"
    }
  }
}`;

export const STATUS = [
  "Experimental. APIs will change.",
  "A write can hold up to 1,000 facts (1 MB).",
  "A query returns at most 2,000 rows.",
  "It hasn't been load-tested yet.",
] as const;
