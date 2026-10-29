// poneglyph.lostera.me.cloudflare.dev: the Poneglyph HTTP API behind a bearer
// token, plus an edge load generator for write benchmarks.
import { WorkerEntrypoint } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";
import { parseGraphId } from "../../../packages/poneglyph/src/domain/graph-id.ts";
import { jsonResponse } from "../../../packages/poneglyph/src/storage/http.ts";
import { dispatchGraphRequest } from "../../../packages/poneglyph/src/storage/implementation.ts";
import { runWriteBench, type BenchEnv } from "./load-generator.ts";

export { GraphCoordinatorDO, GraphLedgerDO, GraphTreeDO, GraphShardDO } from "../../../packages/poneglyph/src/storage/implementation.ts";
export { LoadGenerator } from "./load-generator.ts";
export { CeilingProbe } from "./probe.ts";

type Env = BenchEnv & Readonly<{PONEGLYPH_TOKEN?: string}>;

/** The graph API, unauthenticated: reachable only through this Worker's own DATABASE binding. */
export class Internal extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    return serveGraph(request, this.env);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!authorized(request, env.PONEGLYPH_TOKEN)) return jsonResponse({error: "unauthorized"}, 401);
    const path = new URL(request.url).pathname;
    if (path === "/_bench/writes" && request.method === "POST") return runWriteBench(request, env);
    return serveGraph(request, env);
  },
};

function serveGraph(request: Request, env: Env): Promise<Response> | Response {
  const match = /^\/v1\/graphs\/([^/]+)\/(transactions|query|schema|entities)$/.exec(new URL(request.url).pathname);
  if (match === null) return jsonResponse({error: "not found"}, 404);
  const graphId = parseGraphId(match[1]);
  if (!graphId.ok) return jsonResponse({error: graphId.error.message, path: graphId.error.path}, 400);
  return dispatchGraphRequest(request, env, graphId.value);
}

function authorized(request: Request, token: string | undefined): boolean {
  if (token === undefined || token.length < 32) return false;
  const header = request.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${token}`), given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
