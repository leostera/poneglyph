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
  it("writes validated facts with a stable txId and exposes the commit receipt", async () => {
    const network = createFetch(() => jsonResponse({
      txId: "release:seed-001",
      commitSeq: 7,
      status: "committed",
    }));
    const db = createDatabase({
      url: "https://poneglyph.example/api/",
      graphId: "release-assistant",
      headers: { authorization: "Bearer test-token" },
      fetch: network.fetch,
    });

    const txId = await db.state(facts, { txId: "release:seed-001" });

    expect(txId).toBe("release:seed-001");
    expect(network.requests).toHaveLength(1);
    expect(network.requests[0]?.url).toBe("https://poneglyph.example/api/v1/graphs/release-assistant/transactions");
    const headers = new Headers(network.requests[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-token");
    const body: unknown = JSON.parse(String(network.requests[0]?.init.body));
    expect(body).toMatchObject({
      txId: "release:seed-001",
      facts: [
        { field: "app:service:blocked-by", retraction: false },
        { field: "app:task:status", retraction: false },
      ],
    });

    const receipt = await db.transact(facts, { txId: "release:seed-001" });
    expect(receipt).toEqual({ txId: "release:seed-001", commitSeq: 7, status: "committed" });
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
    expect(await graph.state(facts, { txId: "graph:tx:1" })).toBe("graph:tx:1");
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

  it("rejects malformed writes and queries before performing network requests", async () => {
    const network = createFetch(() => jsonResponse({}));
    const graph = createDatabase({ url: "https://poneglyph.example", graphId: "team-memory", fetch: network.fetch });

    await expect(graph.state([{
      source: "agent:release-assistant",
      entity: "not-a-uri",
      field: "app:task:status",
      value: { type: "text", value: "open" },
    }])).rejects.toBeInstanceOf(PoneglyphInputError);
    await expect(graph.query("not a datalog query")).rejects.toBeInstanceOf(PoneglyphInputError);
    expect(network.requests).toHaveLength(0);
  });

  it("keeps the txId available for safe retry after network and retryable HTTP failures", async () => {
    const failedNetwork = createFetch(() => Promise.reject(new Error("connection reset")));
    const networkDb = createDatabase({ url: "https://poneglyph.example", graphId: "team-memory", fetch: failedNetwork.fetch });
    await expect(networkDb.state(facts, { txId: "retry:tx:1" })).rejects.toMatchObject({
      name: "PoneglyphNetworkError",
      txId: "retry:tx:1",
    });

    const failedResponse = createFetch(() => jsonResponse({ error: "writer busy" }, 423, { "retry-after": "1" }));
    const responseDb = createDatabase({ url: "https://poneglyph.example", graphId: "team-memory", fetch: failedResponse.fetch });
    await expect(responseDb.state(facts, { txId: "retry:tx:2" })).rejects.toMatchObject({
      name: "PoneglyphRequestError",
      status: 423,
      retryable: true,
      retryAfter: "1",
      txId: "retry:tx:2",
    });
  });

  it("rejects malformed successful server responses instead of asserting a commit", async () => {
    const network = createFetch(() => jsonResponse({ txId: "wrong:tx:1", commitSeq: 1, status: "committed" }));
    const graph = createDatabase({ url: "https://poneglyph.example", graphId: "team-memory", fetch: network.fetch });

    await expect(graph.state(facts, { txId: "expected:tx:1" })).rejects.toMatchObject({
      name: "PoneglyphProtocolError",
      txId: "expected:tx:1",
    });
  });
});
