import assert from "node:assert/strict";
import { test } from "vitest";
import { onePieceEntityForPage, parseWikiPageId } from "../onepiece-identities.js";

test("MediaWiki page IDs parse as positive signed 64-bit decimal strings", () => {
  assert.deepEqual(parseWikiPageId("1439"), { ok: true, value: "1439" });
  assert.equal(parseWikiPageId("0").ok, false);
  assert.equal(parseWikiPageId("01439").ok, false);
  assert.equal(parseWikiPageId("1439x").ok, false);
  assert.equal(parseWikiPageId(1439).ok, false);
  assert.equal(parseWikiPageId("9223372036854775808").ok, false);
});

test("semantic entity URIs are stable, opaque, and kind-scoped", () => {
  const pageId = parseWikiPageId("1439");
  assert.equal(pageId.ok, true);
  if (!pageId.ok) return;

  const crewUri = onePieceEntityForPage("crew", pageId.value);
  assert.equal(crewUri, "onepiece:crew:7802a7e4-aeb6-58c5-8999-f08deccc5902");
  assert.equal(new URL(crewUri).protocol, "onepiece:");
  assert.equal(crewUri, onePieceEntityForPage("crew", pageId.value));
  assert.notEqual(crewUri, onePieceEntityForPage("ship", pageId.value));
});
