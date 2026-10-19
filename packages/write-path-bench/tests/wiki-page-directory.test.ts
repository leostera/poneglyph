import assert from "node:assert/strict";
import { test } from "vitest";
import { parseWikiPageId } from "../onepiece-identities.js";
import { WikiPageDirectory } from "../wiki-page-directory.js";

function id(value: string) {
  const parsed = parseWikiPageId(value);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

test("resolves redirects and MediaWiki title spellings to canonical source IDs", () => {
  const directory = new WikiPageDirectory();
  directory.add({ id: id("1439"), title: "Straw Hat Pirates", namespace: "0" });
  directory.add({ id: id("1440"), title: "Mugiwara", namespace: "0", redirectTarget: "Straw_Hat_Pirates#Crew" });

  assert.deepEqual(directory.resolveTitle("mugiwara"), {
    kind: "resolved",
    page: { id: id("1439"), title: "Straw Hat Pirates", namespace: "0" },
  });
  assert.deepEqual(directory.resolvePageId(id("1440")), {
    kind: "resolved",
    page: { id: id("1439"), title: "Straw Hat Pirates", namespace: "0" },
  });
});

test("does not guess through duplicate titles, missing pages, or redirect cycles", () => {
  const directory = new WikiPageDirectory();
  directory.add({ id: id("100"), title: "Blog:Recent posts", namespace: "0" });
  directory.add({ id: id("200"), title: "Blog:Recent posts", namespace: "10" });
  directory.add({ id: id("300"), title: "Alias A", namespace: "0", redirectTarget: "Alias B" });
  directory.add({ id: id("301"), title: "Alias B", namespace: "0", redirectTarget: "Alias A" });

  assert.deepEqual(directory.resolveTitle("Blog:Recent_posts"), {
    kind: "ambiguous", title: "Blog:Recent posts", pageIds: [id("100"), id("200")],
  });
  assert.deepEqual(directory.resolvePageId(id("100")), {
    kind: "resolved", page: { id: id("100"), title: "Blog:Recent posts", namespace: "0" },
  });
  assert.deepEqual(directory.resolveTitle("Unknown Page"), { kind: "missing", title: "Unknown Page" });
  assert.equal(directory.resolveTitle("Alias A").kind, "redirect-cycle");
  assert.equal(directory.resolvePageId(id("999")).kind, "missing");
  assert.deepEqual(directory.audit(), {
    pageRecords: 4,
    duplicateTitleGroups: 1,
    duplicatePageIdGroups: 0,
    duplicateTitleSamples: [{ title: "Blog:Recent posts", pageIds: [id("100"), id("200")] }],
    duplicatePageIdSamples: [],
  });
});
