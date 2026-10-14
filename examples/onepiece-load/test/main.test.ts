import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ingestDump, pageFacts, readPositiveInteger, readNonNegativeInteger, writeBatch, loadConfiguration } from "../src/main.ts";

test("page extraction preserves typed text byte counts and bounded category/link facts", () => {
  const facts = pageFacts({ title: "Test Page", namespace: "0", text: "é [[Category:Test Characters]] [[Other Page|label]]" });
  assert.equal(facts[0]?.field, "wiki:page:title");
  assert.deepEqual(facts[0]?.value, { type: "text", value: "Test Page" });
  assert.deepEqual(facts[2]?.value, { type: "number", value: String(Buffer.byteLength("é [[Category:Test Characters]] [[Other Page|label]]")) });
  assert.ok(facts.some(f => f.field === "wiki:page:type" && f.value.type === "text" && f.value.value === "character"));
  assert.ok(facts.every(f => f.retraction === false));
});

test("small local XML ingestion writes only into a fake callback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poneglyph-example-xml-"));
  try {
    const path = join(directory, "pages.xml");
    await writeFile(path, '<mediawiki><page><title>Test Page</title><ns>0</ns><revision><text>tiny</text></revision></page></mediawiki>');
    const batches: number[] = [];
    const result = await ingestDump(path, 1, async facts => { assert.ok(facts.length <= 500); batches.push(facts.length); });
    assert.equal(result.pages, 1);
    assert.equal(result.facts, batches.reduce((a, b) => a + b, 0));
    assert.ok(result.facts > 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("page/query limits distinguish zero-as-all from positive repetition counts", () => {
  assert.equal(readNonNegativeInteger("0", 5_000), 0);
  assert.equal(readPositiveInteger(undefined, 20), 20);
  for (const input of ["-1", "1.5", "no"]) assert.throws(() => readNonNegativeInteger(input, 5_000));
  assert.throws(() => readPositiveInteger("0", 20));
});

test("configuration carries validated page/repetition limits before any load effect", () => {
  const config = loadConfiguration({ PONEGLYPH_ONEPIECE_XML: "/tmp/custom.xml", PONEGLYPH_ONEPIECE_MAX_PAGES: "0", PONEGLYPH_ONEPIECE_QUERIES: "2" });
  assert.deepEqual(config, { dumpPath: "/tmp/custom.xml", archivePath: "/tmp/custom.xml.7z", maxPages: 0, queryRepetitions: 2 });
  assert.throws(() => loadConfiguration({ PONEGLYPH_ONEPIECE_QUERIES: "0" }), /positive integer/);
});

test("title identity cannot merge punctuation, case or Unicode variants", () => {
  const titles = ["Test Page", "test page", "Test_Page", "A!", "A?", "é", "e"];
  const entities = titles.map(title => pageFacts({ title, namespace: "0", text: "" })[0]!.entity);
  assert.equal(new Set(entities).size, titles.length);
});

test("batch ordinal is not assumed to be a global commit sequence", async () => {
  const facts = pageFacts({ title: "Test Page", namespace: "0", text: "" });
  await writeBatch("https://example.invalid", "example-local", 1, facts, async (_input, init) => {
    const body: Record<string, unknown> = JSON.parse(String(init?.body));
    assert.equal(body["txId"], "poneglyph:tx:onepiece-local:example-local:1");
    return Response.json({ txId: body["txId"], status: "committed", commitSeq: 99 });
  });
});

test("loader surfaces unknown transport once with no fresh or implicit retry", async () => {
  let calls = 0;
  await assert.rejects(writeBatch("https://example.invalid", "example-local", 1, pageFacts({ title: "Test Page", namespace: "0", text: "" }), async () => { calls++; throw new Error("lost transport"); }), /could not reach/);
  assert.equal(calls, 1);
});

test("built loader imports without starting a Worker or corpus load", async (t) => {
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("network forbidden"); });
  const entry = await import(new URL("../dist/main.js", import.meta.url).href);
  assert.equal(typeof entry.main, "function");
  assert.equal(network.mock.callCount(), 0);
});
