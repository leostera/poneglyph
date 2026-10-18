import { describe, expect, it } from "vitest";
import {
  createDatabase,
  PoneglyphInputError,
  type FactInput,
  type FetchFunction,
} from "../src/client.js";

type RecordedRequest = Readonly<{ url: string; init: RequestInit }>;

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
];

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function createFetch(response: (request: RecordedRequest) => Response | Promise<Response>): {
  fetch: FetchFunction;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetch: FetchFunction = async (input, init = {}) => {
    const url = input instanceof URL ? input.href : String(input);
    const request = Object.freeze({ url, init });
    requests.push(request);
    return response(request);
  };
  return { fetch, requests };
}

describe("Poneglyph TypeScript HTTP client", () => {
  it("propagates server elapsed timing and rejects malformed or inconsistent timing", async () => {
    const timing = {executionMs: 10, snapshotMs: 3, evaluationMs: 4, releaseMs: 2};
    const metrics = {scanCalls: 1, shardRequests: 16, distinctShardsTouched: 16, treeReadLeaseAcquisitions: 16, tuplesRead: 1, bytesRead: 100, directoryRequests: 16, cacheHits: 1};
    for (const value of [timing, {...timing, executionMs: -1}, {...timing, snapshotMs: 3.5}, {...timing, executionMs: 1}, {}, null]) {
      const network = createFetch(() => jsonResponse({rows: [], snapshotSeq: 1, metrics: {...metrics, timing: value}}));
      const graph = createDatabase({url: "https://poneglyph.example", graphId: "test", fetch: network.fetch});
      const result = graph.query("test:title(Page, Title)");
      if (value === timing) {
        const parsed = await result;
        expect(parsed.metrics.timing).toEqual(timing);
        expect(parsed.metrics.distinctShardsTouched).toBe(16);
        expect(parsed.metrics.treeReadLeaseAcquisitions).toBe(16);
        expect(parsed.metrics.cacheHits).toBe(1);
      } else await expect(result).rejects.toThrow(/query (timing|metric)/);
    }
  });
  it("sends facts and an optional request token, returning only the server-minted transaction ID", async () => {
    const network = createFetch(() => jsonResponse({txId: "poneglyph:tx:server-minted"}));
    const db = createDatabase({
      url: "https://poneglyph.example/api/",
      graphId: "release-assistant",
      headers: { authorization: "Bearer test-token" },
      fetch: network.fetch,
    });

    const first = await db.transact(facts, {clientRequestToken: "release:seed-001"});

    expect(first).toEqual({txId: "poneglyph:tx:server-minted"});
    expect(network.requests).toHaveLength(1);
    expect(network.requests[0]?.url).toBe("https://poneglyph.example/api/v1/graphs/release-assistant/transactions");
    const headers = new Headers(network.requests[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-token");
    const body: unknown = JSON.parse(String(network.requests[0]?.init.body));
    expect(body).toMatchObject({
      clientRequestToken: "release:seed-001",
      facts: [
        { field: "app:service:blocked-by", retraction: false },
        { field: "app:task:status", retraction: false },
      ],
    });

    const receipt = await db.transact(facts, {clientRequestToken: "release:seed-001"});
    expect(receipt).toEqual({txId: "poneglyph:tx:server-minted"});
  });

  it("creates a graph-scoped client without making a network request", async () => {
    const network = createFetch(() => jsonResponse({
      txId: "graph:tx:1",
      commitSeq: 1,
      status: "committed",
    }));
    const db = createDatabase({ url: "https://poneglyph.example", fetch: network.fetch });
    const graph = db.defineGraph({ id: "team-memory" });

    expect(graph.id).toBe("team-memory");
    expect(network.requests).toHaveLength(0);
    expect(await graph.transact(facts)).toEqual({txId: "graph:tx:1"});
  });

  it("parses an observed schema with its exact subtree snapshot vector", async () => {
    const schema = {
      snapshotSeq: 9,
      sequenceScope: "subtree-vector",
      snapshotVector: [
        {prefix: "0000", sequence: 9, epoch: 2},
        {prefix: "0001", sequence: 7, epoch: 2},
      ],
      fields: [
        {field: "wiki:page:title", valueTags: ["text"]},
        {field: "wiki:page:type", valueTags: ["text", "list"]},
      ],
    };
    const network = createFetch(() => jsonResponse(schema));
    const graph = createDatabase({url: "https://poneglyph.example", graphId: "team-memory", fetch: network.fetch});
    expect(await graph.getSchema()).toEqual(schema);
    expect(network.requests[0]?.url).toBe("https://poneglyph.example/v1/graphs/team-memory/schema");
    expect(JSON.parse(String(network.requests[0]?.init.body))).toEqual({});

    const malformed = createDatabase({url: "https://poneglyph.example", graphId: "team-memory",
      fetch: createFetch(() => jsonResponse({...schema, snapshotSeq: 7})).fetch});
    await expect(malformed.getSchema()).rejects.toMatchObject({name: "PoneglyphProtocolError"});
  });

  it("parses query bindings, the pinned snapshot, and access metrics", async () => {
    const network = createFetch(() => jsonResponse({
      rows: [{
        Service: { type: "string", value: "app:service:auth-api" },
        Task: { type: "string", value: "app:task:rotate-key" },
      }],
      snapshotSeq: 12,
      metrics: { scanCalls: 2, shardRequests: 3, tuplesRead: 5, bytesRead: 420, directoryRequests: 4 },
    }));
    const graph = createDatabase({ url: "https://poneglyph.example", graphId: "team-memory", fetch: network.fetch });

    const result = await graph.query("app:service:blocked-by(Service, Task)");

    expect(network.requests[0]?.url).toBe("https://poneglyph.example/v1/graphs/team-memory/query");
    expect(JSON.parse(String(network.requests[0]?.init.body))).toEqual({
      query: "app:service:blocked-by(Service, Task)",
    });
    expect(result.snapshotSeq).toBe(12);
    expect(result.rows[0]?.["Task"]).toEqual({ type: "string", value: "app:task:rotate-key" });
    expect(result.metrics).toEqual({
      scanCalls: 2,
      shardRequests: 3,
      tuplesRead: 5,
      bytesRead: 420,
      directoryRequests: 4,
    });
  });

  it("bounds client request tokens by UTF-8 bytes before network admission", async () => {
    const network = createFetch(() => jsonResponse({txId: "poneglyph:tx:valid-token"}));
    const graph = createDatabase({url: "https://poneglyph.example", graphId: "team-memory", fetch: network.fetch});
    await expect(graph.transact(facts, {clientRequestToken: ""})).rejects.toBeInstanceOf(PoneglyphInputError);
    await expect(graph.transact(facts, {clientRequestToken: "é".repeat(129)})).rejects.toBeInstanceOf(PoneglyphInputError);
    const valid = "é".repeat(128); // exactly 256 UTF-8 bytes
    await expect(graph.transact(facts, {clientRequestToken: valid})).resolves.toEqual({txId: "poneglyph:tx:valid-token"});
    expect(network.requests).toHaveLength(1);
    expect(JSON.parse(String(network.requests[0]?.init.body))).toMatchObject({clientRequestToken: valid});
  });

  it("rejects malformed writes and queries before performing network requests", async () => {
    const network = createFetch(() => jsonResponse({}));
    const graph = createDatabase({ url: "https://poneglyph.example", graphId: "team-memory", fetch: network.fetch });

    await expect(graph.transact([{
      source: "agent:release-assistant",
      entity: "not-a-uri",
      field: "app:task:status",
      value: { type: "text", value: "open" },
    }])).rejects.toBeInstanceOf(PoneglyphInputError);
    await expect(graph.query("not a datalog query")).rejects.toBeInstanceOf(PoneglyphInputError);
    expect(network.requests).toHaveLength(0);
  });

  it("does not expose internal transaction IDs when delivery may be unknown", async () => {
    const failedNetwork = createFetch(() => Promise.reject(new Error("connection reset")));
    const networkDb = createDatabase({ url: "https://poneglyph.example", graphId: "team-memory", fetch: failedNetwork.fetch });
    await expect(networkDb.transact(facts, {clientRequestToken: "retry:logical-operation"})).rejects.toMatchObject({
      name: "PoneglyphNetworkError",
    });

    const failedResponse = createFetch(() => jsonResponse({ error: "writer busy" }, 423, { "retry-after": "1" }));
    const responseDb = createDatabase({ url: "https://poneglyph.example", graphId: "team-memory", fetch: failedResponse.fetch });
    await expect(responseDb.transact(facts, {clientRequestToken: "retry:logical-operation"})).rejects.toMatchObject({
      name: "PoneglyphRequestError",
      status: 423,
      retryable: true,
      retryAfter: "1",
    });
  });

  it("honors explicit server retryability and falls back to status only when no boolean hint exists", async () => {
    for (const sample of [
      { status: 429, hint: false, expected: false },
      { status: 503, hint: false, expected: false },
      { status: 423, hint: true, expected: true },
      { status: 503, hint: undefined, expected: true },
      { status: 429, hint: "false", expected: true },
    ]) {
      const network = createFetch(() => jsonResponse({ error: "test failure", retryable: sample.hint }, sample.status));
      const graph = createDatabase({ url: "https://poneglyph.example", graphId: "team-memory", fetch: network.fetch });
      await expect(graph.transact(facts, {clientRequestToken: "retry:hint:1"})).rejects.toMatchObject({
        name: "PoneglyphRequestError", status: sample.status, retryable: sample.expected,
      });
      expect(network.requests).toHaveLength(1);
    }
  });

  it("rejects malformed successful server responses instead of asserting a commit", async () => {
    const network = createFetch(() => jsonResponse({}));
    const graph = createDatabase({ url: "https://poneglyph.example", graphId: "team-memory", fetch: network.fetch });

    await expect(graph.transact(facts)).rejects.toMatchObject({name: "PoneglyphProtocolError"});
  });
});
