import assert from "node:assert/strict";
import {test} from "node:test";
import {createServer} from "node:http2";
import {parsePreviewAuthority, previewName} from "../bench/private-preview.js";
import {h2Transport} from "../bench/http2.js";
import {runReadPhase} from "../bench/run.js";

const token = "fake-not-a-real-preview-credential";
const authority = {userWorkerUrl: {protocol: "https:", hostname: `${previewName("read")}.example.workers.dev`}, headers: {"CF-Workers-Preview-Token": token}};
const metrics = {snapshotSeq: 1, hostedMs: 8, serviceMs: 7, snapshotMs: 7, evaluationMs: 0, releaseMs: 0, cacheHits: 1, leases: 0};

test("preview metadata becomes bounded immutable role-scoped authority without exposing private input", () => {
  const parsed = parsePreviewAuthority(authority, "read");
  assert.equal(parsed.origin, `https://${authority.userWorkerUrl.hostname}`);
  assert.equal(parsed.headers["cf-workers-preview-token"], token);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.headers));
  for (const raw of [null, {}, {...authority, userWorkerUrl: {...authority.userWorkerUrl, protocol: "http:"}},
    {...authority, userWorkerUrl: {...authority.userWorkerUrl, hostname: `${previewName("write")}.example.workers.dev`}},
    {...authority, userWorkerUrl: {...authority.userWorkerUrl, hostname: `${previewName("read")}.workers.dev.example.org`}},
    ...["username", "password", "search", "hash"].map(key => ({...authority, userWorkerUrl: {...authority.userWorkerUrl, [key]: "private-test-value"}})),
    {...authority, userWorkerUrl: {...authority.userWorkerUrl, port: "444"}},
    {...authority, userWorkerUrl: {...authority.userWorkerUrl, pathname: "/private-test-value"}},
    {...authority, headers: {}}, {...authority, headers: {":path": "/private-test-value", "cf-workers-preview-token": token}},
    {...authority, headers: {"cf-workers-preview-token": "private\r\nvalue"}},
    {...authority, headers: {"cf-workers-preview-token": token, "CF-Workers-Preview-Token": token}},
    {...authority, headers: {"cf-workers-preview-token": token, Host: "private-test-value"}},
    {...authority, headers: {"cf-workers-preview-token": "x".repeat(16_385)}},
  ]) assert.throws(() => parsePreviewAuthority(raw, "read"), {message: "Invalid private preview authority"});
});

test("direct read phases drain a failed wave, stop later admission and preserve every outcome", async () => {
  let offered = 0, active = 0, maximum = 0;
  const result = await runReadPhase({kind: "combined", count: 32, concurrency: 8}, "test-run", async (path, init) => {
    const index = offered++; active++; maximum = Math.max(maximum, active);
    assert.equal(path, "/combined"); assert.equal(init?.method, "POST");
    await new Promise(accept => setTimeout(accept, 4)); active--;
    return {status: index === 1 ? 503 : 200, async json() { return {runId: "test-run", kind: "complete", metrics}; }};
  });
  assert.equal(offered, 8); assert.equal(active, 0); assert.equal(maximum, 8);
  assert.equal(result.observedMaxInFlight, 8); assert.equal(result.issued, 8); assert.equal(result.successful, 7); assert.equal(result.failed, 1);
  assert.equal(result.allOutcomeCallerMs.count, 8); assert.equal(result.successfulHostedCallerMs.count, 7);
  assert.equal(result.samples.filter(sample => "failure" in sample && sample.failure === "protocol").length, 1);
  assert.ok(result.launchSpanMs >= 0);
});

test("direct HTTP/2 cancellation is counted in all-outcome latency and never retried", async () => {
  let received = 0;
  const server = createServer();
  server.on("stream", () => { received++; }); // Deliberately never reply.
  await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const transport = await h2Transport(`http://127.0.0.1:${address.port}`, {}, 4);
  try {
    const result = await runReadPhase({kind: "point", count: 16, concurrency: 4}, "test-run", transport.request, 30);
    assert.equal(result.issued, 4); assert.equal(result.successful, 0); assert.equal(result.failed, 4);
    assert.equal(result.allOutcomeCallerMs.count, 4); assert.equal(result.successfulHostedCallerMs.p99, null);
    assert.ok(result.samples.every(sample => "failure" in sample && sample.failure === "timeout"));
    assert.equal(received, 4);
  } finally {
    transport.close();
    await new Promise<void>(accept => server.close(() => accept()));
  }
});

test("HTTP/2 transport refuses invalid offered concurrency before opening a session", async () => {
  for (const count of [0, -1, .5, 10_001, NaN, Infinity]) await assert.rejects(h2Transport("not-an-origin", {}, count), /Invalid transport concurrency/);
});
