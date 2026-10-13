import assert from "node:assert/strict";
export type SqlRow = Readonly<Record<string, string | number | null> & {cursor: number}>;
export type InspectionPage =
  | {kind: "router"; children: readonly [string, string]}
  | {kind: "leaf"; rows: readonly SqlRow[]};

// Parse remote evidence into a trusted page before directory traversal or cursor
// advancement. Malformed evidence must fail the checker, not disappear as empty.
export function parseInspectionPage(input: unknown, prefix: string, after: number): InspectionPage {
  assert.ok(input !== null && typeof input === "object" && !Array.isArray(input), "inspection page object");
  const children: unknown = Reflect.get(input, "children"), rows: unknown = Reflect.get(input, "rows");
  assert.ok(Array.isArray(children) && Array.isArray(rows), "inspection page arrays");
  if (children.length) {
    assert.deepEqual(children, [`${prefix}0`, `${prefix}1`], "exact binary directory children");
    assert.equal(rows.length, 0, "router cannot supply authoritative fact rows");
    return {kind: "router", children: [`${prefix}0`, `${prefix}1`]};
  }
  const parsed: SqlRow[] = [];
  let cursor = after;
  for (const row of rows) {
    assert.ok(row !== null && typeof row === "object" && !Array.isArray(row), "SQL row object");
    const entries: [string, string | number | null][] = [];
    for (const [key, value] of Object.entries(row)) {
      assert.ok(value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value)), `SQL scalar ${key}`);
      entries.push([key, value]);
    }
    const parsedRow = Object.fromEntries(entries), next = parsedRow["cursor"];
    assert.ok(typeof next === "number" && Number.isSafeInteger(next) && next > cursor, "strictly increasing SQL row cursor");
    cursor = next; parsed.push({...parsedRow, cursor: next});
  }
  assert.ok(parsed.length <= 128, "bounded inspection page");
  return {kind: "leaf", rows: parsed};
}
