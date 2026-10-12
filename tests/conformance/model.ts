import assert from "node:assert/strict";
import type { FactInput } from "@leostera/poneglyph";
export type Fact = FactInput & {retraction: boolean};
export type Value = FactInput["value"];
export type BindingValue = {type: "string" | "integer"; value: string};
export type Binding = Record<string, BindingValue>;
export type Term = {variable: string} | {constant: BindingValue};
export type Atom = {field: string; entity: Term; value: Term};
export type Query = {source: string; atoms: Atom[]; filter?: (row: Binding) => boolean};
export type Evidence = Record<"fact_log" | "active_facts" | "active_values" | "entity_versions", Record<string, unknown>[]>;
type Assertion = {fact: Fact; txId: string; index: number};

// Deliberately independent of production parsers, projections and evaluator.
export function normalizeValue(value: Value): Value {
  switch (value.type) {
    case "number": return {type: "number", value: BigInt(value.value).toString()};
    case "list": return {type: "list", value: value.value.map(normalizeValue)};
    case "map": return {type: "map", value: Object.fromEntries(Object.entries(value.value).sort(([a], [b]) => unicodeOrder(a, b)).map(([key, item]) => [key, normalizeValue(item)]))};
    case "null": return {type: "null"};
    default: return structuredClone(value);
  }
}
function unicodeOrder(a: string, b: string) {
  const left = [...a].map(char => char.codePointAt(0)!), right = [...b].map(char => char.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
  return left.length - right.length;
}
export function scalar(value: Value): BindingValue {
  if (value.type === "number") return {type: "integer", value: BigInt(value.value).toString()};
  if (value.type === "null") return {type: "string", value: "null"};
  if (value.type === "map" || value.type === "list" || value.type === "bytes") return {type: "string", value: JSON.stringify(value.value)};
  return {type: "string", value: String(value.value)};
}
export function items(value: Value): readonly Value[] {return value.type === "list" ? value.value : [value];}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => unicodeOrder(a, b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function equalBag(actual: readonly unknown[], expected: readonly unknown[], label: string) {
  assert.deepEqual(actual.map(stable).sort(), expected.map(stable).sort(), label);
}
function tuple(fact: Fact) {return stable([fact.source, fact.entity, fact.field, fact.value]);}
function normalized(fact: FactInput): Fact {return {...fact, value: normalizeValue(fact.value), retraction: fact.retraction ?? false};}
function bind(row: Binding, term: Term, value: BindingValue): Binding | undefined {
  if ("constant" in term) return stable(term.constant) === stable(value) ? row : undefined;
  if (term.variable === "_") return row;
  const prior = row[term.variable];
  if (prior && stable(prior) !== stable(value)) return undefined;
  return {...row, [term.variable]: value};
}

export class Model {
  readonly transactions = new Map<string, readonly Fact[]>();
  readonly log: Assertion[] = [];
  readonly active = new Map<string, Assertion>();
  readonly projections = new Map<string, Map<string, Value>>();

  canCommit(input: readonly FactInput[]): boolean {
    const active = new Set(this.active.keys());
    for (const raw of input) {
      const fact = normalized(raw), key = tuple(fact);
      if (fact.retraction && !active.has(key)) return false;
      if (fact.retraction) active.delete(key); else active.add(key);
    }
    return true;
  }
  commit(txId: string, input: readonly FactInput[]) {
    const facts = input.map(normalized), prior = this.transactions.get(txId);
    if (prior) {assert.equal(stable(prior), stable(facts), "oracle identity conflict"); return;}
    assert.ok(this.canCommit(facts), "oracle cannot commit invalid retraction");
    this.transactions.set(txId, facts);
    for (const [index, fact] of facts.entries()) {
      const assertion = {fact, txId, index}; this.log.push(assertion);
      if (fact.retraction) this.active.delete(tuple(fact)); else this.active.set(tuple(fact), assertion);
      const fields = this.projections.get(fact.entity) ?? new Map<string, Value>();
      if (!fact.retraction) fields.set(fact.field, fact.value);
      else if (stable(fields.get(fact.field)) === stable(fact.value)) fields.delete(fact.field);
      this.projections.set(fact.entity, fields);
    }
  }
  query(query: Query): Binding[] {
    let rows: Binding[] = [{}];
    for (const atom of query.atoms) {
      const next: Binding[] = [];
      for (const row of rows) for (const {fact} of this.active.values()) {
        if (fact.field !== atom.field) continue;
        const entity = bind(row, atom.entity, {type: "string", value: fact.entity});
        if (!entity) continue;
        for (const item of items(fact.value)) {const result = bind(entity, atom.value, scalar(item)); if (result) next.push(result);}
      }
      rows = next;
    }
    return query.filter ? rows.filter(query.filter) : rows;
  }
  verifyEvidence(evidence: Evidence) {
    const content = (row: Record<string, unknown>) => ({source: row["source"], entity: row["entity"], field: row["field"], value: JSON.parse(String(row["value_json"])), retraction: Boolean(row["retraction"])});
    equalBag(evidence.fact_log.map(row => ({txId: row["tx_id"], index: row["tx_index"], fact: content(row)})), this.log, "durable exact ordered transaction membership");
    assert.equal(new Set(evidence.fact_log.map(row => row["fact_id"])).size, evidence.fact_log.length, "unique durable fact identities");
    equalBag(evidence.active_facts.map(row => ({txId: row["tx_id"], fact: {...content(row), retraction: false}})),
      [...this.active.values()].map(({txId, fact}) => ({txId, fact})), "active source-qualified assertion membership");
    const values = [...this.active.values()].flatMap(({fact, txId}) => items(fact.value).map((item, index) => ({source: fact.source, entity: fact.entity, field: fact.field, txId, index, item, key: JSON.stringify(item), binding: scalar(item)})));
    equalBag(evidence.active_values.map(row => ({source: row["source"], entity: row["entity"], field: row["field"], txId: row["tx_id"], index: row["value_index"], item: JSON.parse(String(row["value_json"])), key: row["value_key"], binding: {type: row["datalog_type"], value: row["datalog_value"]}})), values, "complete active value/Datalog membership");
    equalBag(evidence.entity_versions.map(row => ({entity: row["entity"], fields: JSON.parse(String(row["fields_json"]))})),
      [...this.projections].filter(([, fields]) => fields.size).map(([entity, fields]) => ({entity, fields: Object.fromEntries(fields)})), "complete current projection membership");
    const facts = new Map(evidence.fact_log.map(row => [row["fact_id"], row]));
    for (const row of evidence.active_facts) assert.ok(facts.has(row["fact_id"]), "active fact references durable truth");
    const activeIds = new Set(evidence.active_facts.map(row => row["fact_id"]));
    for (const row of evidence.active_values) {
      assert.ok(activeIds.has(row["fact_id"]), "index references a current assertion");
      const parent = facts.get(row["fact_id"])!;
      for (const key of ["source", "entity", "field", "tx_id"]) assert.equal(row[key], parent[key], `index parent ${key}`);
      const index = Number(row["value_index"]); assert.ok(Number.isSafeInteger(index) && index >= 0);
      const members = items(JSON.parse(String(parent["value_json"])) as Value);
      assert.equal(stable(JSON.parse(String(row["value_json"]))), stable(members[index]), "index member belongs to its exact fact");
    }
  }
}
export const variable = (name: string): Term => ({variable: name});
export const constant = (value: string, type: "string" | "integer" = "string"): Term => ({constant: {type, value}});
export function relation(field: string, entity?: string): Query {
  return {source: `${field}(${entity ? JSON.stringify(entity) : "Entity"}, Value)`, atoms: [{field, entity: entity ? constant(entity) : variable("Entity"), value: variable("Value")}]};
}
