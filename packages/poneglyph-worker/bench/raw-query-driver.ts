import type PoneglyphService from "../src/index.js";
import {coordinatorObjectName} from "../../poneglyph/src/storage/keys.js";

type Env = { GRAPH: Service<PoneglyphService>; LEDGERS: DurableObjectNamespace; RUN_ID: string };
const graphId = "control-plane-validation";
const tenant = "control:tenant:d9d839ba-4c07-41dc-a5bd-77ccc5763413";
const source = "control:local-read-head-benchmark";
const feature = `${tenant}:feature-settings`;
const text = (entity: string, field: string, value: string) => ({source, entity, field, value: {type: "text" as const, value}, retraction: false});
const facts = [
  {...text(feature, "control:config:enabled", "false"), retraction: true},
  text(feature, "control:config:enabled", "true"),
];
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/recovery-status") {
      const txId = "poneglyph:tx:token:3:9dc31b87-c35f-4f55-ab6f-a547acaff181";
      const ledger = env.LEDGERS.getByName(`${coordinatorObjectName(graphId)}:ledger:3`);
      const statusResponse = await ledger.fetch("https://local.internal/_transaction-status", {method: "POST", body: JSON.stringify({graphId, txId})});
      const transactionStatus = await statusResponse.json();
      const query = await env.GRAPH.query({graphId, query: `control:config:enabled(${JSON.stringify(feature)}, Enabled)`});
      return Response.json({transactionStatus, query});
    }
    if (new URL(request.url).pathname === "/check") {
      try {
        const receipt = await env.GRAPH.transact({graphId, facts, clientRequestToken: `local-heads:${env.RUN_ID}:flip`});
        const bucket = /^poneglyph:tx:token:([0-9a-f]):/.exec(receipt.txId)?.[1];
        if (!bucket) throw new Error("unexpected transaction receipt identity");
        const ledger = env.LEDGERS.getByName(`${coordinatorObjectName(graphId)}:ledger:${bucket}`);
        const statusResponse = await ledger.fetch("https://local.internal/_transaction-status", {method: "POST", body: JSON.stringify({graphId, txId: receipt.txId})});
        const statusBody = await statusResponse.json();
        const query = await env.GRAPH.query({graphId, query: `control:config:enabled(${JSON.stringify(feature)}, Enabled)`});
        return Response.json({receipt: {txId: receipt.txId}, transactionStatus: statusBody, query});
      } catch (error) {
        return Response.json({name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : "unknown"}, {status: 500});
      }
    }
    try {
      const result = await env.GRAPH.query({graphId, query: `control:config:enabled(${JSON.stringify(feature)}, Enabled)`});
      return Response.json(result);
    } catch (error) {
      return Response.json({name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : "unknown"}, {status: 500});
    }
  },
} satisfies ExportedHandler<Env>;
