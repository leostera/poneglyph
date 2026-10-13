import assert from "node:assert/strict";
import type {LocalRuntime} from "./runtime.js";
import type { FactInput } from "@leostera/poneglyph";
import { Model, equalBag, type Evidence, type Query } from "./model.js";
import {parseInspectionPage} from "./inspection-page.js";
import {correctnessBudgets} from "./contract.js";
import {parseReply, errorEvidence} from "./response-evidence.js";
import {QueryCatalogue} from "./query-catalogue.js";

export class Session {
  private readonly catalogue = new QueryCatalogue();
  get queries(): readonly Query[] {return this.catalogue.queries;}
  inheritQueries(queries: readonly Query[]) {this.catalogue.inherit(queries);}
  readonly outcomes: unknown[] = [];
  readonly related: Session[] = [];
  readonly acknowledgedSequences = new Map<string, number>();
  readonly submittedTransactionIds = new Set<string>();
  private stopping = false;
  private readonly inFlight = new Set<Promise<unknown>>();
  private track<T>(work: () => Promise<T>): Promise<T> {
    const pending = work(); this.inFlight.add(pending);
    return pending.finally(() => this.inFlight.delete(pending));
  }
  async drain() {
    this.stopping = true; // Stop new retries, not already admitted effects.
    const results = await Promise.allSettled([...this.inFlight]);
    this.outcomes.push({event: "fail-fast-caller-drain", calls: results.length,
      failed: results.filter(result => result.status === "rejected").map(result => String(result.reason))});
  }
  constructor(readonly runtime: LocalRuntime, readonly graph: string, readonly model = new Model()) {}
  request(operation: object, app = 0, options: {timeoutMs: number} = {timeoutMs: correctnessBudgets.requestMs}) {
    return this.track(() => this.performRequest(operation, app, options));
  }
  private async performRequest(operation: object, app: number, options: {timeoutMs: number}) {
    if (this.stopping) {
      this.outcomes.push({event: "request-not-issued", operation, app, reason: "fail-fast-stop"});
      throw new Error("conformance stopped before issuing this request");
    }
    const invokedAt = new Date().toISOString();
    const input: unknown = Reflect.get(operation, "body") ?? operation;
    if (input && typeof input === "object") {
      const id: unknown = Reflect.get(input, "txId");
      if (typeof id === "string" && id.length <= 1024 && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(id)) this.submittedTransactionIds.add(id);
    }
    this.outcomes.push({event: "request-invoked", operation, app, invokedAt});
    let response: Response | undefined;
    let text: string | undefined;
    let phase: "opening" | "reading-body" | "parsing-reply" = "opening";
    try {
      response = await fetch(this.runtime.endpoints[app]!, {method: "POST", headers: {authorization: `Bearer ${this.runtime.token}`}, body: JSON.stringify({graph: this.graph, ...operation}), signal: AbortSignal.timeout(options.timeoutMs)});
      phase = "reading-body";
      text = await response.text();
      phase = "parsing-reply";
      const body = parseReply(JSON.parse(text));
      this.outcomes.push({operation, app, status: response.status, body, invokedAt, recordedAt: new Date().toISOString()});
      return {status: response.status, body};
    } catch (error) {
      this.outcomes.push({operation, app, status: "unknown", phase, responseStatus: response?.status, text,
        error: String(error), diagnostic: errorEvidence(error), invokedAt, recordedAt: new Date().toISOString()});
      throw error; // Body/parse failures are uncertain too; never silently retry.
    }
  }
  write(name: string, facts: readonly FactInput[], expected = 200, app = 0) {
    return this.track(() => this.performWrite(name, facts, expected, app));
  }
  private async performWrite(name: string, facts: readonly FactInput[], expected: number, app: number) {
    // Catalog names are labels; the public contract requires a URI identity.
    const txId = `tx:${name}`;
    let result = await this.request({action: "write", txId, facts}, app);
    for (let attempt = 1; result.body["retryable"] === true && result.status !== expected && attempt < correctnessBudgets.writeAttempts && !this.stopping; attempt++) {
      await new Promise(resolve => setTimeout(resolve, correctnessBudgets.retryBackoffMs)); result = await this.request({action: "write", txId, facts}, app);
    }
    assert.equal(result.status, expected, `write ${txId}: ${JSON.stringify(result.body)}`);
    if (expected === 200) {
      assert.equal(result.body["txId"], txId); assert.equal(result.body["status"], "committed");
      const sequence = result.body["commitSeq"];
      assert.ok(typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence > 0, "typed positive receipt, not admission");
      const prior = this.acknowledgedSequences.get(txId);
      if (prior !== undefined) assert.equal(sequence, prior, "replay preserves the acknowledged receipt sequence");
      this.model.commit(txId, facts); this.acknowledgedSequences.set(txId, sequence);
    }
    return result;
  }
  async query(query: Query, remember = true) {
    const result = await this.request({action: "query", query: query.source});
    assert.equal(result.status, 200, `query ${query.source}: ${JSON.stringify(result.body)}`);
    assert.ok(Array.isArray(result.body["rows"]), "complete parsed query response");
    equalBag(result.body["rows"], this.model.query(query), `public query ${query.source}`);
    if (remember) this.catalogue.remember(query);
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
  const database = runtime.database;
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
