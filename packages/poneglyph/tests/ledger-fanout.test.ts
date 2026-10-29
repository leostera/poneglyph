import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ledgerBucketForRequestToken, ledgerBucketForTransactionId, ledgerBucketsForGraph, tokenLedgerName, transactionCoordinatorName } from "../src/storage/forest.js";

// RFD0010: only experiment graphs spread over 64 ledgers; every other graph
// keeps its 16 single-digit buckets so existing tokens and IDs route unchanged.
const write = (graph: string, body: object) => exports.default.fetch(new Request(`https://database.test/v1/graphs/${graph}/transactions`, {
  method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body),
}));
const fact = (entity: string) => ({source: "agent:fanout", entity, field: "test:value", value: {type: "text", value: "v"}, retraction: false});

describe("ledger fan-out", () => {
  it.each([
    ["ordinary-graph", 16, /^[0-9a-f]$/],
    ["bench-l64-graph", 64, /^[0-3][0-9a-f]$/],
  ])("routes %s over %i ledgers", async (graph, count, shape) => {
    expect(ledgerBucketsForGraph(graph)).toHaveLength(count);
    const buckets = new Set<string>();
    for (let index = 0; index < 2_000; index++) buckets.add(await ledgerBucketForTransactionId(graph, `poneglyph:tx:${index}`));
    expect(buckets.size).toBe(count);
    for (const bucket of buckets) expect(bucket).toMatch(shape);
    expect(await ledgerBucketForRequestToken(graph, "token")).toMatch(shape);
  });

  it("keeps ordinary graphs on their historical token buckets", async () => {
    // The first hex digit of sha256("graph\0token"), as before the experiment.
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("ordinary-graph\u0000token")))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    expect(await ledgerBucketForRequestToken("ordinary-graph", "token")).toBe(digest[0]);
  });

  it("commits and replays token writes on a 64-ledger graph", async () => {
    const graph = `bench-l64-${crypto.randomUUID()}`, body = {clientRequestToken: "fanout-token", facts: [fact("fanout:entity")]};
    const first = await write(graph, body);
    expect(first.status, await first.clone().text()).toBe(200);
    const {txId} = await first.json() as {txId: string};
    expect(txId).toMatch(/^poneglyph:tx:token:[0-3][0-9a-f]:/);
    expect(await transactionCoordinatorName(graph, txId)).toBe(await tokenLedgerName(graph, "fanout-token"));
    const replay = await write(graph, body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({txId});
    const plain = await write(graph, {facts: [fact("fanout:other")]});
    expect(plain.status, await plain.clone().text()).toBe(200);
  });
});
