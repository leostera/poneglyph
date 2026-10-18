import {exports} from "cloudflare:workers";
import {expect, it} from "vitest";

it("independent grants all change one shared policy without stale-retraction failures", async () => {
  const graphId = `test-write-shape-${crypto.randomUUID()}`;
  for (let index = 0; index < 4; index++) {
    const facts = [{source: "agent:write-benchmark", entity: "control:write-bench:settings", field: "control:policy:allowed-action",
      value: {type: "text", value: `action-${index}`}, retraction: false}];
    const response = await exports.default.fetch(new Request(`https://graph.test/v1/graphs/${graphId}/transactions`, {
      method: "POST", body: JSON.stringify({clientRequestToken: `shape-${index}`, facts}),
    }));
    expect(response.status).toBe(200); await response.body?.cancel();
    const query = await exports.default.fetch(new Request(`https://graph.test/v1/graphs/${graphId}/query`, {
      method: "POST", body: JSON.stringify({query: `control:policy:allowed-action("control:write-bench:settings", "action-${index}")`}),
    }));
    expect(query.status).toBe(200);
    expect(await query.json()).toMatchObject({rows: [{}]});
  }
});
