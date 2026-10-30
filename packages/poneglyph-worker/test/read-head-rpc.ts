import assert from "node:assert/strict";
import type {Miniflare} from "miniflare";
import {isRecord} from "../../poneglyph/src/domain/result.js";
import {parseReadHeadState} from "../../poneglyph/src/storage/read-head-state.js";
import {parseReadHeadParent} from "../../poneglyph/src/storage/read-head-parent.js";

/** Native-RPC composition with the REAL parent, metadata replica and SQLite. */
export async function verifyReadHeadRouting(runtime: Miniflare, entities: readonly string[]): Promise<void> {
  assert.equal(entities.length, 4);
  const call = async (path: string, body?: unknown) => {
    const response = await runtime.dispatchFetch(`https://driver.test${path}`, body === undefined ? {} : {
      method: "POST", body: JSON.stringify(body),
    });
    return {status: response.status, body: await response.json()};
  };
  const state = async (head = false) => {
    const result = await call(head ? "/head-state" : "/write-state");
    assert.equal(result.status, 200);
    assert.ok(isRecord(result.body));
    const {readCutCalls, discoveryCalls, validationCalls} = result.body;
    assert.ok(typeof readCutCalls === "number" && typeof discoveryCalls === "number" && typeof validationCalls === "number");
    return {readCutCalls, discoveryCalls, validationCalls,
      head: result.body["head"] === null ? null : parseReadHeadState(result.body["head"]),
      parent: result.body["parent"] === null ? null : parseReadHeadParent(result.body["parent"])};
  };
  const join = `test:scale-marker(${JSON.stringify(entities[0])}, A), test:scale-marker(${JSON.stringify(entities[1])}, B)`;
  const unchangedQuery = `test:scale-marker(${JSON.stringify(entities[2])}, Value)`;
  const read = (query: string) => call("/one-shot-read", {graphId: "example", query});
  const rows = (value: string) => [{A: {type: "string", value}, B: {type: "string", value}}];
  const checkRows = (reply: Awaited<ReturnType<typeof read>>, expected: unknown) => {
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.ok(isRecord(reply.body));
    assert.deepEqual(reply.body["rows"], expected);
  };
  const unknownRead = {status: 400, body: {name: "PoneglyphRequestError", message: "Graph read failed; a complete answer is unavailable", status: 503, retryable: true}};
  const unknownWrite = {status: 400, body: {name: "PoneglyphRequestError", message: "Graph write failed; delivery may be unknown", status: 503, retryable: true}};

  // Allow the negative discovery hint from pre-opt-in reads to expire. This is
  // only a routing cooldown; it grants no time-based freshness permission.
  await new Promise(resolve => setTimeout(resolve, 1_050));
  checkRows(await read(join), rows("present")); // cold canonical lease path
  checkRows(await read(join), rows("present")); // discover and freshly validate
  checkRows(await read(unchangedQuery), [{Value: {type: "string", value: "present"}}]);
  checkRows(await read(unchangedQuery), [{Value: {type: "string", value: "present"}}]);
  const rootBefore = await state(), headBefore = await state(true);
  try {
    await call("/cache-unavailable");
    const settled = await Promise.allSettled(Array.from({length: 16}, () => read(join)));
    for (const outcome of settled) {
      assert.equal(outcome.status, "fulfilled");
      checkRows(outcome.value, rows("present"));
      assert.ok(isRecord(outcome.value.body) && isRecord(outcome.value.body["metrics"]));
      assert.equal(outcome.value.body["metrics"]["cacheHits"], 1);
    }
    const rootAfter = await state(), headAfter = await state(true);
    assert.equal(rootAfter.readCutCalls, rootBefore.readCutCalls, "warm head reads do not touch canonical read-cut authority");
    assert.equal(rootAfter.discoveryCalls, rootBefore.discoveryCalls, "membership discovery is not a per-read canonical hop");
    assert.equal(headAfter.validationCalls - headBefore.validationCalls, 16, "EVERY cache hit has its own fresh head validation");
    assert.deepEqual(await call("/one-shot-unknown"), {status: 400, body: {name: "GraphAuthorizationError", message: "Graph access denied"}});
  } finally { await call("/cache-reset"); }

  // Missing/corrupt head authority can only fall back to fresh canonical
  // authority. It cannot turn a completed result or a routing hint into a hit.
  await call("/head-unavailable");
  const beforeFallback = await state();
  checkRows(await read(join), rows("present"));
  assert.equal((await state()).readCutCalls, beforeFallback.readCutCalls + 1);
  try {
    await call("/head-malformed"); await call("/cache-unavailable");
    assert.deepEqual(await read(join), unknownRead);
  } finally { await call("/head-reset"); await call("/cache-reset"); }

  // Two-owner writes, actual freezes and lost freeze/activation acknowledgements.
  // While affected projections fail closed, an unchanged third owner can still
  // validate against BOTH sides of the frozen complete view.
  let previous = "present";
  for (const phase of ["freeze", "activate"] as const) {
    const next = `after-${phase}`;
    const facts = entities.slice(0, 2).flatMap(entity => [
      {source: "test:write-scaling", entity, field: "test:scale-marker", value: {type: "text", value: previous}, retraction: true},
      {source: "test:write-scaling", entity, field: "test:scale-marker", value: {type: "text", value: next}},
    ]);
    const write = {graphId: "example", facts, clientRequestToken: `test:routing:${phase}`};
    await call(`/head-block-${phase}`);
    assert.deepEqual(await call("/one-shot-write", write), unknownWrite);
    assert.equal((await state(true)).head?.mode, "frozen");
    try {
      await call("/cache-unavailable");
      checkRows(await read(unchangedQuery), [{Value: {type: "string", value: "present"}}]);
      assert.deepEqual(await read(join), unknownRead, "a changed frozen projection cannot validate old completed rows");
    } finally { await call("/cache-reset"); }
    // Canonical cut is transaction-closed even before caller acknowledgement.
    checkRows(await read(join), rows(phase === "freeze" ? previous : next));
    await call("/head-reset"); await call("/head-pump");
    const reconciled = await call("/one-shot-write", write); // explicit same-token test reconciliation
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
    checkRows(await read(join), rows(next));
    checkRows(await read(join), rows(next));
    previous = next;
  }

  const beforeRetire = await state();
  assert.ok(beforeRetire.parent !== null);
  const retired = await call("/retire-head", {expectedGeneration: beforeRetire.parent.generation});
  assert.equal(retired.status, 200, JSON.stringify(retired.body));
  assert.equal((await state(true)).head?.mode, "retired");
  const staleHint = await state(), retiredBefore = await state(true);
  checkRows(await read(join), rows(previous));
  const afterRetiredRead = await state(), retiredAfter = await state(true);
  assert.equal(afterRetiredRead.discoveryCalls, staleHint.discoveryCalls, "the fixture actually uses a retained stale membership hint");
  assert.equal(afterRetiredRead.readCutCalls, staleHint.readCutCalls + 1);
  assert.equal(retiredAfter.validationCalls, retiredBefore.validationCalls + 1);
  try {
    await call("/cache-unavailable");
    assert.deepEqual(await read(join), unknownRead, "an irreversibly retired head cannot authorize even a still-current cached result");
  } finally { await call("/cache-reset"); }
}
