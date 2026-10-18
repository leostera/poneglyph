import type PoneglyphService from "../src/index.js";
import { coordinatorObjectName } from "../../poneglyph/src/storage/keys.js";

type Env = { TEST_FACADE: DurableObjectNamespace; READER: Service<PoneglyphService>; WRITER: Service<PoneglyphService>; UNKNOWN: Service<PoneglyphService>; MISSING: Service<PoneglyphService>; MALFORMED: Service<PoneglyphService>; NO_STORAGE: Service<PoneglyphService> };
const facts = [
  { source: "test:a", entity: "test:e", field: "test:title", value: { type: "text" as const, value: "hello" } },
  { source: "test:b", entity: "test:e", field: "test:title", value: { type: "text" as const, value: "hello" } },
  { source: "test:a", entity: "test:e", field: "test:bytes", value: { type: "number" as const, value: "9007199254740993" } },
  { source: "test:a", entity: "test:e2", field: "test:status", value: { type: "text" as const, value: "active" } },
];
export default {
  async fetch(request: Request, env: Env) {
    const path = new URL(request.url).pathname;
    try {
      if (["/cache-unavailable", "/cache-malformed", "/cache-reset"].includes(path)) {
        return env.TEST_FACADE.getByName(coordinatorObjectName("example")).fetch(`https://test.internal/_test-${path.slice(1)}`);
      }
      if (path === "/change-pointed") {
        using graph = await env.WRITER.getGraph({graphId: "example"});
        return Response.json(await graph.transact([
          {source: "test:a", entity: "test:e2", field: "test:status", value: {type: "text", value: "active"}, retraction: true},
          {source: "test:a", entity: "test:e2", field: "test:status", value: {type: "text", value: "inactive"}},
        ], {clientRequestToken: "test:change-pointed"}));
      }
      if (path === "/one-shot") return Response.json(await env.READER.query({graphId: "example", query: 'test:title("test:e", T), test:status("test:e2", S)'}));
      if (path === "/one-shot-denied") return Response.json(await env.READER.query({graphId: "other", query: "test:title(E, T)"}));
      if (path === "/one-shot-unknown") return Response.json(await env.UNKNOWN.query({graphId: "example", query: "test:title(E, T)"}));
      if (path === "/one-shot-forged") return Response.json(await env.READER.query(await request.json<{graphId: string; query: string}>()));
      if (path === "/acquire-only" || path === "/deny-before-storage") {
        using graph = await env.NO_STORAGE.getGraph({ graphId: "example" });
        if (path === "/deny-before-storage") return Response.json(await graph.transact(facts));
        return Response.json({ id: await graph.id });
      }
      if (path === "/raw-selection") {
        using graph = await env.READER.getGraph(await request.json<{ graphId: string }>());
        return Response.json(await graph.query("test:title(E, T)"));
      }
      if (path === "/bad-write" || path === "/conflict") {
        using graph = await env.WRITER.getGraph({ graphId: "example" });
        return Response.json(await graph.transact(
          [{...facts[0], value: {type: "text", value: "changed"}}],
          {clientRequestToken: path === "/bad-write" ? "" : "test:original"},
        ));
      }
      if (path === "/parallel-seed") {
        const write = async () => {
          using graph = await env.WRITER.getGraph({graphId: "example"});
          return graph.transact(facts, {clientRequestToken: "test:original"});
        };
        return Response.json(await Promise.all([write(), write()]));
      }
      if (path === "/seed" || path === "/second") {
        using graph = await env.WRITER.getGraph({ graphId: path === "/seed" ? "example" : "other" });
        return Response.json(await graph.transact(
          path === "/second" ? facts.map(fact => ({...fact, source: "test:other", value: {type: "text", value: "other"}})) : facts,
          {clientRequestToken: "test:original"},
        ));
      }
      if (path === "/unknown") { using graph = await env.UNKNOWN.getGraph({ graphId: "example" }); return Response.json(await graph.query("test:title(E, T)")); }
      if (path === "/missing") { using graph = await env.MISSING.getGraph({ graphId: "example" }); return Response.json(await graph.query("test:title(E, T)")); }
      if (path === "/malformed") { using graph = await env.MALFORMED.getGraph({ graphId: "example" }); return Response.json(await graph.query("test:title(E, T)")); }
      using graph = await env.READER.getGraph({ graphId: path === "/forbidden-graph" ? "other" : "example" });
      if (path === "/write") return Response.json(await graph.transact(facts));
      if (path === "/bad-query") return Response.json(await graph.query("not Datalog"));
      if (path === "/integer") return Response.json(await graph.query('test:bytes("test:e", Value)'));
      if (path === "/pointed-join") return Response.json(await graph.query('test:title("test:e", T), test:status("test:e2", S)'));
      if (path === "/schema") return Response.json(await graph.getSchema());
      if (path === "/identity") return Response.json({ id: await graph.id });
      return Response.json(await graph.query("test:title(E, T)"));
    } catch (error) {
      // Prove native enhanced RPC error fields, not instanceof custom classes.
      if (!(error instanceof Error)) return Response.json({ name: "unknown" }, { status: 400 });
      return Response.json({ name: error.name, message: error.message,
        ...("status" in error ? { status: error.status } : {}),
        ...("retryable" in error ? { retryable: error.retryable } : {}),
        ...("txId" in error ? { txId: error.txId } : {}),
      }, { status: 400 });
    }
  },
} satisfies ExportedHandler<Env>;
