import assert from "node:assert/strict";
import { test } from "node:test";
import { visitMediaWikiPages } from "../wiki-xml.js";

async function* chunks(input: string, size: number): AsyncGenerator<Uint8Array> {
  const bytes = Buffer.from(input, "utf8");
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

test("streams direct page identities, redirects, decoded text, and split UTF-8 safely", async () => {
  const xml = `<?xml version="1.0"?><mediawiki>
    <page><title>Straw Hat Pirates</title><ns>0</ns><id>1439</id><revision><id>999</id><text bytes="20">Crew &amp; [[Mugiwara]]</text></revision></page>
    <page><title>Mugiwara</title><ns>0</ns><id>1440</id><redirect title="Straw Hat Pirates"/><revision><id>1000</id><text><![CDATA[Alias crew – 麦わら]]></text></revision></page>
  </mediawiki>`;
  const pages: Array<{ id: string; title: string; namespace: string; text: string; redirectTarget?: string }> = [];
  await visitMediaWikiPages(chunks(xml, 7), page => { pages.push(page); });

  assert.deepEqual(pages, [
    { id: "1439", title: "Straw Hat Pirates", namespace: "0", text: "Crew & [[Mugiwara]]" },
    { id: "1440", title: "Mugiwara", namespace: "0", text: "Alias crew – 麦わら", redirectTarget: "Straw Hat Pirates" },
  ]);
});

test("rejects a page without a valid page ID", async () => {
  const xml = "<mediawiki><page><title>Missing ID</title><ns>0</ns><revision><id>10</id><text>content</text></revision></page></mediawiki>";
  await assert.rejects(() => visitMediaWikiPages(chunks(xml, 64), () => {}), /positive decimal MediaWiki page ID/);
});
