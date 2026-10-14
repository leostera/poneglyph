import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase } from "@leostera/poneglyph";

export function deploymentUrl(input: string | undefined): URL {
  if (input === undefined || input.length === 0) throw new TypeError("Set PONEGLYPH_CLOUDFLARE_URL to an explicitly approved validation target");
  const endpoint = new URL(input);
  if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".poneglyph.leostera.dev") ||
      endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "" || endpoint.pathname !== "/") {
    throw new TypeError("deployed validation requires a credential-free HTTPS origin under *.poneglyph.leostera.dev");
  }
  return endpoint;
}

export async function main(environment: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Promise<void> {
  const endpoint = deploymentUrl(environment["PONEGLYPH_CLOUDFLARE_URL"]);
  const graphId = `cf-scaleout-${randomUUID()}`, txId = `poneglyph:tx:${randomUUID()}`;
  const entities = Array.from({ length: 4 }, (_, index) => `wiki:person:cf-scaleout-${index}`);
  const facts = entities.map((entity, index) => ({
    source: "agent:cf-scaleout-validation", entity, field: "schema:name",
    value: { type: "text" as const, value: `Poneglyph scale-out test ${index}` }, retraction: false,
  }));
  const graph = createDatabase({ url: endpoint, fetch: fetcher }).defineGraph({ id: graphId });
  // The public client parses exact receipt identity and does not silently retry
  // uncertain delivery. A manual reconciliation must reuse this graph/ID/input.
  const committed = await graph.transact(facts, { txId });
  const replayed = await graph.transact(facts, { txId });
  assert.deepEqual(replayed, committed, "same identity/input must return the original exact receipt");
  const query = await graph.query('schema:name(Entity, Name), startsWith(Name, "Poneglyph scale-out test")');
  const expected = facts.map(fact => JSON.stringify([{ type: "string", value: fact.entity }, { type: "string", value: fact.value.value }])).sort();
  const actual = query.rows.map(row => {
    assert.deepEqual(Object.keys(row).sort(), ["Entity", "Name"], "exact query binding variables");
    return JSON.stringify([row["Entity"], row["Name"]]);
  }).sort();
  assert.deepEqual(actual, expected, "exact typed multiset of all acknowledged entities/names");
  // Neither a graph-global scalar clock nor one physical root is promised by G.
  console.log(JSON.stringify({ baseUrl: endpoint.origin, graphId, txId, factsWritten: facts.length,
    commitSeq: committed.commitSeq, replayStatus: replayed.status, snapshotSeq: query.snapshotSeq,
    rows: query.rows.length, metrics: query.metrics }, null, 2));
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
