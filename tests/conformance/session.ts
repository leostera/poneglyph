import assert from "node:assert/strict";
import { startLocal, type LocalRuntime } from "./runtime.js";
import type { FactInput } from "@leostera/poneglyph";
import { Model, equalBag, type Evidence, type Query } from "./model.js";
import {parseInspectionPage} from "./inspection-page.js";
import {correctnessBudgets} from "./contract.js";

export class Session {
  readonly queries: Query[] = [];
  readonly outcomes: unknown[] = [];
  readonly related: Session[] = [];
  constructor(readonly runtime: LocalRuntime, readonly graph: string, readonly model = new Model()) {}
  async request(operation: object, app = 0, options: {timeoutMs: number} = {timeoutMs: correctnessBudgets.requestMs}) {
    let response: Response;
    try {
      response = await fetch(this.runtime.endpoints[app]!, {method: "POST", headers: {authorization: `Bearer ${this.runtime.token}`}, body: JSON.stringify({graph: this.graph, ...operation}), signal: AbortSignal.timeout(options.timeoutMs)});
    } catch (error) {
      this.outcomes.push({operation, app, status: "unknown", error: String(error), cause: error instanceof Error ? String(error.cause) : undefined});
      throw error; // Record uncertainty; do not hide it with an implicit retry.
    }
    const text = await response.text();
    let body: Record<string, unknown>;
    try {body = JSON.parse(text);} catch {throw new Error(`invalid response ${response.status}: ${text}`);}
    this.outcomes.push({operation, app, status: response.status, body});
    return {status: response.status, body};
  }
  async write(name: string, facts: readonly FactInput[], expected = 200, app = 0) {
    // Catalog names are labels; the public contract requires a URI identity.
    const txId = `tx:${name}`;
    let result = await this.request({action: "write", txId, facts}, app);
    for (let attempt = 1; result.body["retryable"] === true && result.status !== expected && attempt < correctnessBudgets.writeAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, correctnessBudgets.retryBackoffMs)); result = await this.request({action: "write", txId, facts}, app);
    }
    assert.equal(result.status, expected, `write ${txId}: ${JSON.stringify(result.body)}`);
    if (expected === 200) {
      assert.equal(result.body["txId"], txId); assert.equal(result.body["status"], "committed");
      assert.ok(Number.isSafeInteger(result.body["commitSeq"]) && Number(result.body["commitSeq"]) > 0, "positive receipt, not admission");
      this.model.commit(txId, facts);
    }
    return result;
  }
  async query(query: Query, remember = true) {
    const result = await this.request({action: "query", query: query.source});
    assert.equal(result.status, 200, `query ${query.source}: ${JSON.stringify(result.body)}`);
    assert.ok(Array.isArray(result.body["rows"]), "complete parsed query response");
    equalBag(result.body["rows"], this.model.query(query), `public query ${query.source}`);
    if (remember) this.queries.push(query);
  }
  async verify() {
    for (const query of this.queries) await this.query(query, false);
    for (const [entity, fields] of this.model.projections) {
      const result = await this.request({action: "entity", entity}); assert.equal(result.status, 200);
      const projection = result.body["entity"] as {uri?: unknown; fields?: unknown} | null;
      if (fields.size === 0) assert.equal(projection, null, `empty projection ${entity}`);
      else {
        assert.equal(projection?.uri, entity, "entity response identity");
        assert.deepEqual(projection?.fields, Object.fromEntries(fields), `public entity ${entity}`);
      }
    }
    this.model.verifyEvidence(await inspect(this.runtime, this.graph));
  }
}
export async function inspect(runtime: LocalRuntime, graph: string): Promise<Evidence> {
  const database = await runtime.mf.getWorker("database");
  const evidence: Evidence = {fact_log: [], active_facts: [], active_values: [], entity_versions: []};
  const pending = [""], visited = new Set<string>();
  while (pending.length) {
    const prefix = pending.shift()!; assert.ok(!visited.has(prefix), "directory cycle"); visited.add(prefix); assert.ok(visited.size <= 511, "bounded inspection directory");
    for (const table of Object.keys(evidence) as (keyof Evidence)[]) {
      let after = 0;
      while (true) {
        const url = new URL("https://audit.internal/__e2e/inspect");
        for (const [key, value] of Object.entries({graph, prefix, table, after: String(after)})) url.searchParams.set(key, value);
        const response = await database.fetch(url, {headers: {authorization: `Bearer ${runtime.token}`}});
        assert.equal(response.status, 200, await response.clone().text());
        const page = parseInspectionPage(await response.json(), prefix, after);
        if (page.kind === "router") {if (table === "fact_log") pending.push(...page.children); break;}
        if (page.rows.length === 0) break;
        evidence[table].push(...page.rows); after = page.rows.at(-1)!.cursor;
      }
    }
  }
  return evidence;
}
export async function restart(runtime: LocalRuntime, persistence: string, bundles: string) {
  const {graphId, token} = runtime; await runtime.mf.dispose();
  return startLocal(graphId, persistence, 4, token, bundles);
}
