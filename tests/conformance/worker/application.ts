import { createDatabase, PoneglyphInputError, PoneglyphRequestError, type FactInput } from "@leostera/poneglyph";

interface ApplicationEnv {DATABASE: Fetcher; CONFORMANCE_TOKEN: string; WORKER_ID: string}
export default {
  async fetch(request: Request, env: ApplicationEnv): Promise<Response> {
    if (request.headers.get("authorization") !== `Bearer ${env.CONFORMANCE_TOKEN}`) return new Response("unauthorized", {status: 401});
    const body = await request.json() as {graph: string; action: string; txId: string; facts: FactInput[]; query: string; entity: string; path: string; body: unknown};
    const database = createDatabase({url: "https://database.internal", graphId: body.graph,
      fetch: (input, init) => env.DATABASE.fetch(input, init)});
    try {
      switch (body.action) {
        case "write": return Response.json(await database.transact(body.facts, {txId: body.txId}));
        case "lost-write-reply": {
          await database.stateFacts(body.facts, {txId: body.txId});
          // Shared semantic fault: lose the application response only AFTER a
          // real committed database receipt. This is not a fabricated commit.
          return Response.json({error: "injected lost application reply", retryable: true}, {status: 502});
        }
        case "query": return Response.json(await database.query(body.query));
        case "entity": return env.DATABASE.fetch(`https://database.internal/v1/graphs/${body.graph}/entities?uri=${encodeURIComponent(body.entity)}`);
        case "raw": return env.DATABASE.fetch(`https://database.internal/v1/graphs/${body.graph}/${body.path}`, {
          method: "POST", body: JSON.stringify(body.body), headers: {"content-type": "application/json"},
        });
        default: return new Response("unknown operation", {status: 400});
      }
    } catch (error) {
      if (error instanceof PoneglyphRequestError) return Response.json({error: error.message, retryable: error.retryable}, {status: error.status});
      if (error instanceof PoneglyphInputError) return Response.json({error: error.message, retryable: false}, {status: 400});
      return Response.json({error: String(error), retryable: true}, {status: 502});
    }
  },
};
