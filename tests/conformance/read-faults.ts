import assert from "node:assert/strict";
import type {Case} from "./small.js";
import {relation} from "./model.js";
import type {Session} from "./session.js";
import {parseReadFaultMode, type ReadFaultMode} from "./worker/read-fault.js";
import {parseInspectionPage} from "./inspection-page.js";

// Placement discovery is only for targeting a transport fault. It never supplies
// expected facts/answers; the reference model still comes from submitted input.
export async function entityLeaf(s: Session, entity: string) {
  const database = await s.runtime.mf.getWorker("database"), pending = [""], seen = new Set<string>();
  while (pending.length) {
    const prefix = pending.shift()!; assert.ok(!seen.has(prefix), "fault discovery directory cycle"); seen.add(prefix); assert.ok(seen.size <= 511, "bounded fault discovery");
    const url = new URL("https://control.internal/__e2e/inspect");
    for (const [key, value] of Object.entries({graph: s.graph, prefix, table: "fact_log", after: "0"})) url.searchParams.set(key, value);
    const response = await database.fetch(url, {headers: {authorization: `Bearer ${s.runtime.token}`}});
    assert.equal(response.status, 200);
    const page = parseInspectionPage(await response.json(), prefix, 0);
    if (page.kind === "leaf") {
      if (page.rows.some(row => row["entity"] === entity)) return prefix;
    } else pending.push(...page.children);
  }
  throw new Error("control cannot find the actual entity participant");
}
async function control(s: Session, prefix: string, mode?: ReadFaultMode) {
  const database = await s.runtime.mf.getWorker("database"), url = new URL("https://control.internal/__e2e/read-fault");
  url.searchParams.set("graph", s.graph); url.searchParams.set("prefix", prefix);
  const response = await database.fetch(url, {method: mode === undefined ? "GET" : "POST", headers: {authorization: `Bearer ${s.runtime.token}`}, ...(mode === undefined ? {} : {body: JSON.stringify(mode)})});
  assert.equal(response.status, 200);
  const body = parseFaultStatus(await response.json());
  s.outcomes.push({control: "read-fault", prefix, mode, body}); return body;
}
function parseFaultStatus(input: unknown) {
  assert.ok(input !== null && typeof input === "object" && !Array.isArray(input), "fault status object");
  const mode = parseReadFaultMode(Reflect.get(input, "mode"));
  const hits: unknown = Reflect.get(input, "hits"), successfulScans: unknown = Reflect.get(input, "successfulScans");
  assert.ok(typeof hits === "number" && Number.isSafeInteger(hits) && hits >= 0, "fault hit count");
  assert.ok(typeof successfulScans === "number" && Number.isSafeInteger(successfulScans) && successfulScans >= 0 && successfulScans <= hits, "actual successful scan count");
  return {mode, hits, successfulScans};
}
const modes: ReadFaultMode[] = ["unavailable-before", "malformed", "empty-eof", "record-eof", "record-error"];
export const readFaultCases: Case[] = modes.map(mode => ({name: `read-fault/${mode}`, async run(s) {
  const entity = "test:stream-entity";
  await s.write("stream-seed", ["first", "second"].map(value => ({source: "agent:stream", entity, field: "test:stream", value: {type: "text" as const, value}})));
  const query = relation("test:stream"); await s.query(query);
  const prefix = await entityLeaf(s, entity); await control(s, prefix, mode);
  try {
    const result = await s.request({action: "query", query: query.source});
    const status = await control(s, prefix);
    assert.equal(status.mode, mode, "exact configured semantic fault");
    assert.ok(status.hits > 0, "fault must intercept an actual participant request");
    if (mode !== "unavailable-before") assert.ok(status.successfulScans > 0, "transport fault wraps a real successful shard scan");
    assert.ok(result.status >= 400, `partial scan must fail closed, not return successful partial rows: ${JSON.stringify(result.body)}`);
    assert.equal(result.body["rows"], undefined, "failed query cannot expose a successful partial result");
  } finally {await control(s, prefix, "none");}
  await s.query(query); // Removing a test fault is not data repair; truth is intact.
}}));
