import { createHash } from "node:crypto";
import { parseImportPlan } from "../src/import-contract.js";

export const entity = "wiki:onepiece:page:Import%20Boundary%20Fixture";
const corpus = "a".repeat(64), xml = "b".repeat(64);
export const txId = `wiki:import:${corpus}:pages10:0`;
export const facts = [
  { source: `wiki:onepiece:dump:${xml}`, entity, field: "wiki:page:title", value: { type: "text", value: "Import Boundary Fixture" }, retraction: false },
  { source: `wiki:onepiece:dump:${xml}`, entity, field: "wiki:page:namespace", value: { type: "number", value: "0" }, retraction: false },
];
export const body = JSON.stringify({ batch: 0, txId, facts });
export function fixturePlan() {
  const now = Date.now();
  return parseImportPlan({ version: 1, graphId: "onepiece", service: "poneglyph-service-worker", corpusSha256: corpus, xmlSha256: xml,
    source: facts[0].source, totalPages: 10, selectedPages: 1, selectedFacts: 2,
    openedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString(),
    batches: [{ txId, sha256: createHash("sha256").update(body).digest("hex"), facts: 2, pages: 1, bytes: Buffer.byteLength(body) }] });
}
