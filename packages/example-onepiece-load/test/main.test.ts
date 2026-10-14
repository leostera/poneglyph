import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ingestDump, pageFacts, readPositiveInteger, readNonNegativeInteger } from "../src/main.ts";

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

test("built loader imports without starting a Worker or corpus load", async (t) => {
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("network forbidden"); });
  const entry = await import(new URL("../dist/main.js", import.meta.url).href);
  assert.equal(typeof entry.main, "function");
  assert.equal(network.mock.callCount(), 0);
});
