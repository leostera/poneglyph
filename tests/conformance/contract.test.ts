import assert from "node:assert/strict";
import {test} from "vitest";
import {correctnessBudgets, requiredCoverage, smallTierComplete, statefulSeeds} from "./contract.js";

test("required coverage cannot silently certify the unfinished tier", () => {
  assert.equal(smallTierComplete, false);
  assert.equal(requiredCoverage.length, 9);
  assert.equal(new Set(requiredCoverage.map(group => group.family)).size, 9);
  for (const group of requiredCoverage) assert.ok(group.remaining.length > 0);
});
test("32 stable uint32 seed inputs are recorded, not claimed executed", () => {
  assert.equal(statefulSeeds.length, 32); assert.equal(new Set(statefulSeeds).size, 32);
  assert.deepEqual(statefulSeeds.slice(0, 3), [1831565813, 191034286, 2845470055]);
  for (const seed of statefulSeeds) assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff);
});
test("correctness budgets are finite and unchanged by fault control", () => {
  for (const budget of Object.values(correctnessBudgets)) assert.ok(Number.isSafeInteger(budget) && budget > 0);
  assert.equal(correctnessBudgets.writeAttempts, 16);
  assert.equal(correctnessBudgets.requestMs, 30_000);
  assert.ok(correctnessBudgets.replyBarrierSafetyMs > correctnessBudgets.inFlightReadMs);
});
