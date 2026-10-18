import assert from "node:assert/strict";
import {test} from "node:test";
import {payload, settings, classify} from "../bench/write/model.js";
import {settledBurst} from "../bench/write/burst.js";
import {h2Transport} from "../bench/write/direct.js";
import {createServer, type ServerHttp2Stream, type IncomingHttpHeaders} from "node:http2";

test("write scope cannot select existing graphs or an unbounded burst", () => {
  const run = "00000000-0000-4000-8000-000000000000";
  assert.match(settings(run, "hot", 10_000).graphId, /^write-bench-hot-/);
  for (const count of [0, -1, 10_001, 1.5, NaN]) assert.throws(() => settings(run, "hot", count));
  for (const kind of ["onepiece", "control-plane-validation", "", null]) assert.throws(() => settings(run, kind, 10));
  assert.throws(() => settings("unbound", "hot", 10));
});
test("hot updates independently add distinct grants to one shared policy", () => {
  const scope = settings("00000000-0000-4000-8000-000000000000", "hot", 2);
  for (const index of [0, 1]) {
    const result = payload(scope, {index});
    assert.equal(result.facts.length, 1);
    assert.equal(result.facts[0]?.retraction, false);
    assert.equal(result.facts[0]?.entity, "control:write-bench:settings");
    assert.deepEqual(result.facts[0]?.value, {type: "text", value: `action-${index}`});
  }
  assert.throws(() => payload(scope, {index: 0, facts: []}));
  for (const index of [-1, 2, 1.5, "0"]) assert.throws(() => payload(scope, {index}));
});
test("graph payloads require three real-page assertions for one entity", () => {
  const scope = settings("00000000-0000-4000-8000-000000000000", "graph", 1);
  const facts = ["title", "category", "link"].map(field => ({source: "fixture:onepiece-fandom", entity: "wiki:onepiece:page:test",
    field: `wiki:page:${field}`, value: {type: "text", value: "test"}, retraction: false}));
  assert.equal(payload(scope, {index: 0, facts}).facts.length, 3);
  assert.throws(() => payload(scope, {index: 0, facts: facts.slice(0, 2)}));
  assert.throws(() => payload(scope, {index: 0, facts: facts.map(fact => ({...fact, source: "arbitrary"}))}));
  assert.throws(() => payload(scope, {index: 0, facts: facts.map((fact, i) => ({...fact, entity: `${fact.entity}:${i}`}))}));
  assert.equal(classify(423, {error: "private payload must not escape"}), "contention");
  assert.equal(classify(503, {error: "overloaded fake-private-detail"}), "overloaded");
});
test("direct HTTP/2 delivers 10,000 independent incoming requests without the local singleton proxy", async () => {
  const server = createServer({settings: {maxConcurrentStreams: 100}});
  let active = 0, peak = 0, arrived = 0;
  const pending: (() => void)[] = [];
  server.on("stream", (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
    assert.equal(headers["x-benchmark-test"], "fake-not-a-credential");
    active++; peak = Math.max(peak, active); arrived++;
    pending.push(() => { active--; stream.respond({":status": 200}); stream.end('{"complete":true}'); });
    if (arrived === 10_000) for (const finish of pending) finish();
  });
  await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
  const address = server.address(); assert(address !== null && typeof address !== "string");
  const transport = await h2Transport(`http://127.0.0.1:${address.port}`, {"x-benchmark-test": "fake-not-a-credential"}, 10_000);
  try {
    const result = await settledBurst(Array.from({length: 10_000}, (_, i) => i), async () => {
      const response = await transport.request("/write", {body: "{}", signal: AbortSignal.timeout(20_000)});
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), {complete: true});
    });
    assert.equal(result.outcomes.filter(outcome => outcome.status === "fulfilled").length, 10_000);
    assert.equal(peak, 10_000); assert.equal(active, 0); assert.equal(arrived, 10_000);
  } finally { transport.close(); await new Promise<void>(accept => server.close(() => accept())); }
});

test("10,000 offered concurrent calls are all issued and settled without retry", async () => {
  let release!: () => void;
  const gate = new Promise<void>(accept => { release = accept; });
  let issued = 0;
  const pending = settledBurst(Array.from({length: 10_000}, (_, i) => i), async index => {
    issued++; await gate; if (index % 7 === 0) throw new Error("fake failure"); return index;
  });
  assert.equal(issued, 10_000); release();
  const result = await pending;
  assert.equal(result.observedMaximumCallerInFlight, 10_000);
  assert.equal(result.outcomes.length, 10_000);
  assert.equal(result.outcomes.filter(outcome => outcome.status === "rejected").length, 1429);
  assert.equal(issued, 10_000);
});
