import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { prepareOnePieceEnrichment } from "../prepare-enrichment.js";

const xml = `<?xml version="1.0"?><mediawiki>
  <page><title>Monkey D. Luffy</title><ns>0</ns><id>1</id><revision><id>101</id><text>{{Char Box|affiliation=[[Straw Hat Pirates]]|occupation=[[Captain]]}}</text></revision></page>
  <page><title>Straw Hat Pirates</title><ns>0</ns><id>2</id><revision><id>102</id><text>[[Category:East Blue Pirate Crews]]</text></revision></page>
  <page><title>Captain</title><ns>0</ns><id>3</id><revision><id>103</id><text>A role page.</text></revision></page>
  <page><title>Mugiwara</title><ns>0</ns><id>4</id><redirect title="Straw Hat Pirates"/><revision><id>104</id><text>#REDIRECT [[Straw Hat Pirates]]</text></revision></page>
</mediawiki>`;

test("prepares a local, digest-pinned semantic overlay and refuses to overwrite it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poneglyph-enrichment-test-"));
  try {
  const xmlPath = join(directory, "wiki.xml");
  const manifestPath = join(directory, "corpus-manifest.json");
  const outputPath = join(directory, "enrichment-v1");
  await writeFile(xmlPath, xml);
  const xmlSha256 = createHash("sha256").update(xml).digest("hex");
  await writeFile(manifestPath, JSON.stringify({ xmlSha256, pages: 4 }));

  const result = await prepareOnePieceEnrichment(xmlPath, manifestPath, outputPath);
  assert.equal(result.pages, 4);
  assert.equal(result.outputDirectory, outputPath);
  assert.equal(result.facts, 20);
  assert.ok(result.factsByField["onepiece:affiliation"] === 1);
  assert.ok(result.factsByField["onepiece:occupation"] === 1);
  assert.ok(result.factsByField["onepiece:alias"] === 1);
  assert.equal(result.issues["wikitext-parse"], undefined);

  const factLines = (await readFile(join(outputPath, "facts.ndjson"), "utf8")).trim().split("\n");
  assert.equal(factLines.length, result.facts);
  assert.equal(createHash("sha256").update(`${factLines.join("\n")}\n`).digest("hex"), result.factsSha256);
  const facts = factLines.map(line => JSON.parse(line) as { field: string; entity: string; value: { type: string; value?: string } });
  assert.ok(facts.some(fact => fact.field === "onepiece:affiliation" && fact.entity.startsWith("onepiece:character:")));
  assert.ok(facts.some(fact => fact.field === "onepiece:alias" && fact.value.value === "Mugiwara"));
  const outputManifest = JSON.parse(await readFile(join(outputPath, "manifest.json"), "utf8")) as { status: string; policies: { remoteWrites: boolean } };
  assert.equal(outputManifest.status, "complete");
  assert.equal(outputManifest.policies.remoteWrites, false);

  await assert.rejects(() => prepareOnePieceEnrichment(xmlPath, manifestPath, outputPath), /refusing to overwrite/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
