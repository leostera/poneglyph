import { createDatabase, type FactInput } from "@leostera/poneglyph";

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

export async function quickstart(url: string, fetcher: typeof fetch = fetch) {
  const graph = createDatabase({ url, fetch: fetcher }).defineGraph({ id: "release-assistant" });
  // Reusing this identity with the same facts makes reruns idempotent.
  const txId = await graph.stateFacts(facts, { txId: "release:quickstart-v1" });
  const result = await graph.query(
    'app:service:blocked-by(Service, Task), app:task:status(Task, "open"), app:task:owner(Task, Owner)',
  );
  return { txId, snapshotSeq: result.snapshotSeq, rows: result.rows };
}

export async function main(): Promise<void> {
  const url = process.env["PONEGLYPH_URL"];
  if (url === undefined || url.length === 0) {
    throw new Error("Set PONEGLYPH_URL to the local or deployed Poneglyph Worker URL");
  }
  console.log(JSON.stringify(await quickstart(url), null, 2));
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
