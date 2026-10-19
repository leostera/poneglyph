import assert from "node:assert/strict";
export type Interval = Readonly<{id: string; invoked: number; settled: number}>;
// Exhaustive bounded caller-history orders, not a graph-global receipt order.
// An operation settled before another was invoked must precede it; overlapping
// calls may execute in either order. The bound is a fixture budget, not a DB limit.
export function legalOrders(input: readonly Interval[]): readonly (readonly string[])[] {
  assert.ok(input.length > 0 && input.length <= 4, "bounded history requires 1–4 operations");
  assert.equal(new Set(input.map(x => x.id)).size, input.length, "distinct history identities");
  for (const op of input) {
    assert.ok(typeof op.id === "string" && op.id.length > 0);
    assert.ok(Number.isSafeInteger(op.invoked) && op.invoked >= 0 && Number.isSafeInteger(op.settled) && op.settled > op.invoked, "actual ordered caller interval");
  }
  const orders: string[][] = [];
  function visit(prefix: string[], remaining: readonly Interval[]) {
    if (!remaining.length) {orders.push(prefix); return;}
    for (const next of remaining) {
      if (remaining.some(prior => prior.id !== next.id && prior.settled < next.invoked)) continue;
      visit([...prefix, next.id], remaining.filter(op => op.id !== next.id));
    }
  }
  visit([], input); assert.ok(orders.length > 0, "caller intervals admit a legal history");
  return orders;
}
export function legalPrefixes(order: readonly string[], intervals: readonly Interval[], read: Omit<Interval, "id">): readonly (readonly string[])[] {
  const admitted = legalOrders(intervals);
  assert.ok(admitted.some(candidate => candidate.length === order.length && candidate.every((id, index) => id === order[index])), "prefix source is an enumerated legal order");
  assert.ok(Number.isSafeInteger(read.invoked) && read.invoked >= 0 && Number.isSafeInteger(read.settled) && read.settled > read.invoked);
  return Array.from({length: order.length + 1}, (_, length) => order.slice(0, length)).filter(prefix => intervals.every(op =>
    !(op.settled < read.invoked && !prefix.includes(op.id)) && !(op.invoked > read.settled && prefix.includes(op.id))));
}
