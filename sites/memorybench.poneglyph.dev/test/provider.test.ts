import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { GRAPH_SCOPES } from "../src/registry.js";
import { rawFacts, claimFacts, evidenceMessages, batches, chunks, type Session } from "../bench/facts.js";
import { PoneglyphProvider } from "../bench/provider.js";
import type { ModelClient } from "../bench/model.js";

const scope = [...GRAPH_SCOPES.values()].find(s => s.benchmark === "locomo" && s.variant === "a")!;
const extractedScope = [...GRAPH_SCOPES.values()].find(s => s.container === scope.container && s.variant === "b" && s.benchmark === scope.benchmark)!;
const session: Session = { sessionId: "fixture-session", metadata: { date: "2026-01-01", formattedDate: "January 1, 2026" }, messages: [
  { role: "user", speaker: "Alice", content: "I live in Oslo." }, { role: "assistant", content: "" },
] };

test("deterministic facts preserve empty content, speakers, dates, ordering and provenance", () => {
  const facts = rawFacts(scope, session);
  assert.deepEqual(rawFacts(scope, session), facts);
  assert.ok(facts.some(f => f.field === "memory:text" && f.value.type === "text" && f.value.value === ""));
  assert.ok(facts.some(f => f.field === "memory:speaker" && f.value.type === "text" && f.value.value === "Alice"));
  assert.equal(facts.filter(f => f.field === "memory:ordinal").length, 2);
  assert.ok(facts.every(f => f.source === `memorybench:${scope.datasetHash}:a` && !f.retraction));
  assert.equal(batches([...facts, ...facts]).flat().length, facts.length * 2);
  assert.ok(batches(Array.from({ length: 201 }, () => facts[0]!)).every(batch => batch.length <= 100));
});
test("claim parsing rejects hallucinated evidence and malformed/extra keys", () => {
  const evidence = evidenceMessages(session);
  const claim = { subject: "Alice", predicate: "lives in", object: "Oslo", evidence: [evidence[0]!.id] };
  const facts = claimFacts(extractedScope, "fixture-chunk", [claim], evidence);
  assert.ok(facts.some(f => f.field === "memory:evidence" && f.value.type === "reference" && f.value.value === evidence[0]!.id));
  assert.throws(() => claimFacts(extractedScope, "x", [{ ...claim, evidence: ["invented"] }], evidence));
  assert.throws(() => claimFacts(extractedScope, "x", [{ ...claim, question: "leaked" }], evidence));
  assert.throws(() => claimFacts(extractedScope, "x", [{ ...claim, evidence: [] }], evidence));
  assert.throws(() => chunks([{ id: "long", role: "user", content: "x".repeat(100_000) }]));
});

test("unknown delivery retains ID; only durable abort changes it; committed replay is no-op", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memorybench-journal-"));
  vi.stubEnv("MEMORYBENCH_STATE_DIR", directory);
  const sent: { txId: string; facts: unknown[] }[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { txId: string; facts: unknown[] };
    sent.push(body);
    if (sent.length === 1) return Response.json({ delivery: "unknown" }, { status: 502 });
    if (sent.length === 2) return Response.json({ delivery: "rejected", status: 422 }, { status: 502 });
    return Response.json({ status: "committed", txId: body.txId, commitSeq: 1 });
  };
  const noModel: ModelClient = { async complete() { throw new Error("Variant A must not extract"); } };
  try {
    const provider = new PoneglyphProvider("a", noModel, fetcher);
    await provider.initialize({ apiKey: "", benchmark: "locomo", dataSourceRunId: "fixture-run" });
    const options = { containerTag: `${scope.container}-fixture-run` };
    const first = await provider.ingest([session], options);
    assert.equal(sent.length, 3);
    assert.equal(sent[0]!.txId, sent[1]!.txId);
    assert.equal(sent[2]!.txId, `${sent[0]!.txId}:retry:1`);
    assert.deepEqual(sent[0]!.facts, sent[2]!.facts);
    assert.deepEqual(await provider.ingest([session], options), first);
    assert.equal(sent.length, 3);
    await provider.awaitIndexing(first, options.containerTag);
    await assert.rejects(provider.ingest([{ ...session, messages: [{ role: "user", content: "changed" }] }], options), /configuration changed/);
    await assert.rejects(provider.clear(options.containerTag), /deletion is not supported/);
    await assert.rejects(provider.ingest([session], { containerTag: `${scope.container}-wrong-run` }), /wrong source/);
  } finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
});

test("extraction is haystack-only, grounded, persisted and not regenerated on replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memorybench-extraction-"));
  vi.stubEnv("MEMORYBENCH_STATE_DIR", directory);
  let modelCalls = 0, writes = 0;
  const model: ModelClient = { async complete(role, messages) {
    assert.equal(role, "extraction");
    const input = JSON.parse(String(messages[1]!.content)) as { messages: { id: string }[] };
    assert.deepEqual(Object.keys(input).sort(), ["date", "messages"]);
    modelCalls++;
    return { content: JSON.stringify([{ subject: "Alice", predicate: "lives in", object: "Oslo", evidence: [input.messages[0]!.id] }]), calls: [], raw: {} };
  } };
  const fetcher: typeof fetch = async (_input, init) => {
    writes++;
    const body = JSON.parse(String(init?.body)) as { txId: string };
    return Response.json({ txId: body.txId, status: "committed", commitSeq: writes });
  };
  try {
    const provider = new PoneglyphProvider("b", model, fetcher);
    await provider.initialize({ apiKey: "", benchmark: "locomo", dataSourceRunId: "fixture-run" });
    const options = { containerTag: `${scope.container}-fixture-run` };
    await provider.ingest([session], options);
    await provider.ingest([session], options);
    assert.equal(modelCalls, 1);
    assert.equal(writes, 1);
  } finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
});
