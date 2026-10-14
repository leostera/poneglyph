import assert from "node:assert/strict";
import test from "node:test";
import { authorizeGraph, GraphAuthorizationError, parseGraphRequest, parseIdentity, staticAuthorizer } from "../src/authorization.js";

const identity = parseIdentity({ clientId: "reader" });
const graph = parseGraphRequest({ graphId: "example" });

test("trusted binding identity and graph selection are parsed, exact and frozen", () => {
  assert.deepEqual(identity, { clientId: "reader" });
  assert.deepEqual(graph, { graphId: "example" });
  assert.ok(Object.isFrozen(identity) && Object.isFrozen(graph));
  for (const input of [undefined, null, [], {}, { clientId: "" }, { clientId: "reader", permissions: ["write"] }, Object.create({ clientId: "reader" })]) assert.throws(() => parseIdentity(input), GraphAuthorizationError);
  for (const input of [undefined, {}, { graphId: "EXAMPLE" }, { graphId: "example", clientId: "writer" }, { graphId: "example", access: "read-write" }, { graphId: "example", url: "https://other" }]) assert.throws(() => parseGraphRequest(input), GraphAuthorizationError);
});

test("static authorizer snapshots configuration and never uses prototype grants", async () => {
  const mutable: { reader: { example: ("read" | "write")[] } } = { reader: { example: ["read"] } };
  const policy = staticAuthorizer(mutable);
  mutable.reader.example.push("write");
  assert.deepEqual(await authorizeGraph(policy, identity, graph), ["read"]);
  assert.deepEqual(await policy.permissionsFor({ clientId: "constructor", graphId: graph.graphId }), []);
  assert.deepEqual(await policy.permissionsFor({ clientId: "reader", graphId: parseGraphRequest({ graphId: "different" }).graphId }), []);
});

test("unknown clients, ungranted graphs and empty grants fail closed", async () => {
  const policy = staticAuthorizer({ reader: { example: [] }, writer: { example: ["read", "write"] } });
  await assert.rejects(authorizeGraph(policy, identity, graph), GraphAuthorizationError);
  await assert.rejects(authorizeGraph(policy, parseIdentity({ clientId: "unknown" }), graph), GraphAuthorizationError);
  const permissions = await authorizeGraph(policy, parseIdentity({ clientId: "writer" }), graph);
  assert.deepEqual(permissions, ["read", "write"]);
  assert.ok(Object.isFrozen(permissions));
});

test("malformed entire policies are rejected, never partially installed", () => {
  for (const input of [undefined, [], { reader: [] }, { reader: { INVALID: ["read"] } }, { reader: { example: ["admin"] } }, { reader: { example: ["read", "read"] } }, { reader: { example: ["write"] } }, { reader: { example: "read" } }]) assert.throws(() => staticAuthorizer(input), GraphAuthorizationError);
});
