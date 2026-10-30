// Explicit LOCAL Miniflare experiment only. Never a deployment entrypoint.
import type PoneglyphService from "../src/index.js";
import {coordinatorObjectName} from "../../poneglyph/src/storage/keys.js";
import {parseGraphId} from "../../poneglyph/src/domain/graph-id.js";
import {readHeadReplicaName} from "../../poneglyph/src/storage/read-head-placement.js";
import {isRecord} from "../../poneglyph/src/domain/result.js";

const graphId = "control-plane-validation";
const tenant = "control:tenant:d9d839ba-4c07-41dc-a5bd-77ccc5763413";
const source = "control:local-read-head-benchmark";
const text = (entity: string, field: string, value: string) => ({source, entity, field, value: {type: "text" as const, value}, retraction: false});
const facts = [
  text(`${tenant}:feature-settings`, "control:config:tenant", tenant),
  text(`${tenant}:feature-settings`, "control:config:enabled", "false"),
  text(`${tenant}:credential-settings`, "control:credential:tenant", tenant),
  text(`${tenant}:credential-settings`, "control:credential:token-version", "fake-token-test-only-v0-d9d839ba-4c07-41dc-a5bd-77ccc5763413"),
  text(`${tenant}:credential-settings`, "control:credential:status", "active"),
];
type Env = {PONEGLYPH: Service<PoneglyphService>; FACADE: DurableObjectNamespace; RUN_ID: string};
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST" || request.headers.has("origin")) return new Response("Not found", {status: 404});
    const path = new URL(request.url).pathname;
    if (path === "/seed") return Response.json(await env.PONEGLYPH.transact({
      graphId, facts, clientRequestToken: `local-heads:${env.RUN_ID}:seed`,
    }));
    if (path === "/flip") return Response.json(await env.PONEGLYPH.transact({
      graphId,
      facts: [
        {...text(`${tenant}:feature-settings`, "control:config:enabled", "false"), retraction: true},
        text(`${tenant}:feature-settings`, "control:config:enabled", "true"),
      ],
      clientRequestToken: `local-heads:${env.RUN_ID}:flip`,
    }));
    const root = env.FACADE.getByName(coordinatorObjectName(graphId));
    if (path === "/join") {
      const response = await root.fetch("https://local.internal/_read-head-status", {method: "POST", body: JSON.stringify({graphId})});
      const status: unknown = await response.json();
      if (!response.ok || !isRecord(status) || !Number.isSafeInteger(status["generation"])) throw new Error("Invalid local status");
      return root.fetch("https://local.internal/_read-head-join", {method: "POST", body: JSON.stringify({graphId, expectedGeneration: status["generation"]})});
    }
    if (path !== "/counts") return new Response("Not found", {status: 404});
    const response = await root.fetch("https://local.internal/_test-write-state");
    const raw: unknown = await response.json();
    if (!response.ok || !isRecord(raw)) throw new Error("Invalid local counters");
    const parent = raw["parent"], members = isRecord(parent) && Array.isArray(parent["members"]) ? parent["members"] : [];
    const graph = parseGraphId(graphId);
    if (!graph.ok || members.length > 100) throw new Error("Invalid local roster");
    const heads = await Promise.all(members.map(async member => {
      if (typeof member !== "number") throw new Error("Invalid local member");
      const answer = await env.FACADE.getByName(readHeadReplicaName(graph.value, member)).fetch("https://local.internal/_test-write-state");
      const value: unknown = await answer.json();
      if (!answer.ok || !isRecord(value) || typeof value["validationCalls"] !== "number") throw new Error("Invalid local head counters");
      return {member, validations: value["validationCalls"]};
    }));
    return Response.json({readCutCalls: raw["readCutCalls"], discoveryCalls: raw["discoveryCalls"], heads});
  },
} satisfies ExportedHandler<Env>;
