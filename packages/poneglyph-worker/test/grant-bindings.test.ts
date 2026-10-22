import assert from "node:assert/strict";
import { test } from "vitest";
import { parseGraphId } from "@leostera/poneglyph";
import { splitGrantBindings } from "../src/grant-bindings.js";
import { authorizerFromBindings, GraphAuthorizationError } from "../src/authorization.js";
import { memorybenchGrants } from "../memorybench-grants.js";
test("bounded deployment grant variables reassemble exactly without wildcard access", async () => {
  const chunks = splitGrantBindings(memorybenchGrants);
  assert.ok(Object.keys(chunks).length > 1);
  for (const chunk of Object.values(chunks)) assert.ok(Buffer.byteLength(JSON.stringify(chunk)) <= 4096);
  const authorizer = authorizerFromBindings(chunks);
  for (const [clientId, graphs] of Object.entries(memorybenchGrants)) for (const [id, permissions] of Object.entries(graphs)) {
    const parsed = parseGraphId(id);
    assert.ok(parsed.ok);
    assert.deepEqual(await authorizer.permissionsFor({ clientId, graphId: parsed.value }), permissions);
  }
  const other = parseGraphId("onepiece-wiki"); assert.ok(other.ok);
  assert.deepEqual(await authorizer.permissionsFor({ clientId: "memorybench-reader", graphId: other.value }), []);
  assert.throws(() => authorizerFromBindings({}), GraphAuthorizationError);
  assert.throws(() => authorizerFromBindings({ GRAPH_GRANTS: { reader: { example: ["read"] } }, GRAPH_GRANTS_01: { reader: { example: ["read", "write"] } } }), GraphAuthorizationError);
  assert.throws(() => authorizerFromBindings({ GRAPH_GRANTS: {}, GRAPH_GRANTS_wrong: {} }), GraphAuthorizationError);
});
