import assert from "node:assert/strict";
import test from "node:test";
import {ReadHeadRouter, parseReadHeadDiscovery} from "../src/read-head-routing.js";
import {parseGraphId} from "../../poneglyph/src/domain/graph-id.js";
import type {StorageEnv} from "../../poneglyph/src/storage/environment.js";
import {TREE_PREFIXES} from "../../poneglyph/src/storage/forest.js";
import {sampleReadHeadMembers} from "../../poneglyph/src/storage/read-head-placement.js";
import {parseReadIdentity} from "../../poneglyph/src/storage/read-identity.js";

const parsedGraph = parseGraphId("read-head-routing");
if (!parsedGraph.ok) throw new Error("Invalid fixture graph");
const graphId = parsedGraph.value;
const identity = parseReadIdentity([{prefix: TREE_PREFIXES[0], directoryEpoch: 0, snapshotSeq: 7}], [TREE_PREFIXES[0]!]);
const query = 'test:value("test:e", Value)';
type Call = Readonly<{name: string; request: Request}>;
function fixture(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const namespace = {getByName(name: string) { return {fetch(input: RequestInfo | URL, init?: RequestInit) {
    const call = {name, request: new Request(input, init)};
    calls.push(call);
    return Promise.resolve(reply(call));
  }}; }};
  const env: StorageEnv = {GRAPH_FACADES: namespace, GRAPH_LEDGERS: namespace, GRAPH_SHARDS: namespace, GRAPH_TREES: namespace};
  return {env, calls};
}
const path = (call: Call) => new URL(call.request.url).pathname;
const roster = () => Response.json({enabled: true, generation: 3, members: [1, 2]});
const unchanged = () => Response.json({unchanged: true, snapshotSeq: 7});

test("read-head discovery is an exact, bounded, immutable routing hint", () => {
  const members = parseReadHeadDiscovery({enabled: true, generation: 9, members: [1, 4, 8]});
  assert.deepEqual(members, [1, 4, 8]);
  assert.ok(Object.isFrozen(members));
  assert.deepEqual(parseReadHeadDiscovery({enabled: false, generation: 0, members: []}), []);
  for (const input of [null, [], {}, {enabled: false, generation: 2, members: []},
    {enabled: false, generation: 1, members: [1]}, {enabled: true, generation: 2, members: [1, 1]},
    {enabled: true, generation: 2, members: [3]}, {enabled: true, generation: 2, members: [0]},
    {enabled: true, generation: 2, members: [1.5]}, {enabled: true, generation: -1, members: []},
    {enabled: true, generation: 2, members: [1], authority: true},
    {enabled: true, generation: 1_000, members: Array.from({length: 257}, (_, i) => i + 1)}]) {
    assert.throws(() => parseReadHeadDiscovery(input));
  }
});

test("bounded discovery windows can reach every member beyond the per-hint budget", () => {
  const members = Array.from({length: 513}, (_, i) => i + 1);
  const reached = new Set<number>();
  for (const start of [0, 256, 512]) {
    const window = sampleReadHeadMembers(members, start);
    assert.equal(window.length, 256);
    assert.equal(new Set(window).size, 256);
    assert.ok(Object.isFrozen(window));
    window.forEach(member => reached.add(member));
    assert.deepEqual(parseReadHeadDiscovery({enabled: true, generation: 513, members: window}), window);
  }
  assert.equal(reached.size, 513, "a bounded hint must not become a fixed global replica ceiling");
  assert.deepEqual(sampleReadHeadMembers([], 0), []);
  assert.throws(() => sampleReadHeadMembers(members, -1));
});

test("warm completed-result checks select fresh heads without per-read canonical calls", async () => {
  let sample = 0;
  const router = new ReadHeadRouter(() => 1, () => sample);
  const f = fixture(call => path(call) === "/_read-head-discover" ? roster() : unchanged());
  for (let i = 0; i < 32; i++) {
    sample = i % 2 === 0 ? 0 : 0.999;
    assert.deepEqual(await router.validate(f.env, graphId, query, identity), {kind: "unchanged"});
  }
  assert.equal(f.calls.filter(call => path(call) === "/_read-head-discover").length, 1);
  const validations = f.calls.filter(call => path(call) === "/_read-head-validate");
  assert.equal(validations.length, 32);
  assert.equal(new Set(validations.map(call => call.name)).size, 2);
  assert.deepEqual(await validations[0]!.request.json(), {graphId, member: 1, query, knownSnapshot: identity});
});

test("head responses cannot turn changed, retired, malformed or failed authority into a hit", async () => {
  for (const reply of [{canonical: true}, {unchanged: true}, {unchanged: true, snapshotSeq: 8},
    {unchanged: true, snapshotSeq: 7, canonical: true}, {unchanged: true, snapshotSeq: 7, rows: []}, null]) {
    const router = new ReadHeadRouter(() => 1, () => 0);
    const f = fixture(call => path(call) === "/_read-head-discover" ? roster() : Response.json(reply));
    const result = await router.validate(f.env, graphId, query, identity);
    assert.equal(result.kind, "canonical");
  }
  for (const status of [400, 404, 409, 423, 500, 503]) {
    const f = fixture(call => path(call) === "/_read-head-discover" ? roster() : new Response("private-upstream-detail", {status}));
    assert.deepEqual(await new ReadHeadRouter().validate(f.env, graphId, query, identity), {kind: "canonical", reason: "unavailable"});
  }
});

test("membership hints may be stale but every positive result still requires fresh head authority", async () => {
  let now = 1, discoverable = true, requests = 0;
  const router = new ReadHeadRouter(() => now, () => 0);
  const f = fixture(call => {
    if (path(call) === "/_read-head-discover") return discoverable ? roster() : new Response("unavailable", {status: 503});
    requests++;
    return unchanged();
  });
  assert.equal((await router.validate(f.env, graphId, query, identity)).kind, "unchanged");
  now += 30_001; discoverable = false;
  assert.equal((await router.validate(f.env, graphId, query, identity)).kind, "unchanged");
  assert.equal(requests, 2, "discovery failure is not a time-based snapshot permission");
  assert.equal(f.calls.filter(call => path(call) === "/_read-head-discover").length, 2);
});

test("failed/disabled discovery is retried after a bounded cooldown, not on every concurrent read", async () => {
  let now = 0, enabled = false;
  const router = new ReadHeadRouter(() => now, () => 0);
  const f = fixture(call => path(call) === "/_read-head-discover"
    ? enabled ? roster() : Response.json({enabled: false, generation: 0, members: []}) : unchanged());
  for (let i = 0; i < 8; i++) assert.equal((await router.validate(f.env, graphId, query, identity)).kind, "canonical");
  assert.equal(f.calls.length, 1);
  enabled = true; now = 1_001;
  assert.equal((await router.validate(f.env, graphId, query, identity)).kind, "unchanged");
  assert.equal(f.calls.length, 3);
});

test("concurrent cold discovery never shares another request's promise or blocks its canonical fallback", {timeout: 2_000}, async () => {
  let complete!: (response: Response) => void;
  const discovery = new Promise<Response>(resolve => { complete = resolve; });
  const router = new ReadHeadRouter(() => 1, () => 0);
  const f = fixture(call => path(call) === "/_read-head-discover" ? discovery : unchanged());
  const first = router.validate(f.env, graphId, query, identity);
  assert.deepEqual(await router.validate(f.env, graphId, query, identity), {kind: "canonical", reason: "not-selected"});
  assert.equal(f.calls.length, 1);
  complete(roster());
  assert.equal((await first).kind, "unchanged");
});

test("head request cancellation settles before canonical fallback", {timeout: 2_000}, async () => {
  let aborted = false;
  const f = fixture(call => {
    if (path(call) === "/_read-head-discover") return roster();
    return new Promise<Response>((_resolve, reject) => {
      call.request.signal.addEventListener("abort", () => { aborted = true; reject(new Error("private-platform-error")); }, {once: true});
    });
  });
  assert.deepEqual(await new ReadHeadRouter().validate(f.env, graphId, query, identity), {kind: "canonical", reason: "unavailable"});
  assert.ok(aborted);
});

test("head routing envelope budget cannot make a complete canonical read invalid", async () => {
  const f = fixture(call => { assert.equal(path(call), "/_read-head-discover"); return roster(); });
  assert.deepEqual(await new ReadHeadRouter().validate(f.env, graphId, "x".repeat(17_000), identity), {kind: "canonical", reason: "budget"});
  assert.equal(f.calls.length, 1);
});
