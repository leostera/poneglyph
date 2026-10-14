import assert from "node:assert/strict";
import { test } from "node:test";
import { extractTopLevelWikiLinks, scanCategoryLinks, scanTopLevelTemplates, scanTopLevelWikiLinks } from "../wikitext-templates.js";

test("scans requested top-level infoboxes and ignores nested templates, comments, and literal blocks", () => {
  const text = `
{{Featured Article|tier=featured}}
{{Char Box
|affiliation=[[Roger Pirates]];{{Qref|name=debut|note=[[not an affiliation]]}} [[Will of D.|Clan of D.]]
|occupation=[[Pirate Captain]]{{Qref|chap=1}}
|rank=[[Captain|Captain]]
|alias={{Nihongo|Gold Roger|ゴールド・ロジャー}}
|affiliation=[[Roger Pirates]]
}}
<!-- {{Char Box|affiliation=[[commented out]]}} -->
<nowiki>{{Char Box|affiliation=[[literal text]]}}</nowiki>
{{Ship Box|captain=[[Monkey D. Luffy]]|affiliation=[[Thousand Sunny]]}}
`;

  const result = scanTopLevelTemplates(text, ["Char Box", "Ship Box"]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.templates.length, 2);

  const character = result.templates[0]!;
  assert.equal(character.name, "Char Box");
  assert.deepEqual(character.fields.filter(field => field.name === "affiliation").map(field => extractTopLevelWikiLinks(field.value)), [
    ["Roger Pirates", "Will of D."],
    ["Roger Pirates"],
  ]);
  assert.deepEqual(extractTopLevelWikiLinks(character.fields.find(field => field.name === "occupation")!.value), ["Pirate Captain"]);
  assert.deepEqual(extractTopLevelWikiLinks(character.fields.find(field => field.name === "rank")!.value), ["Captain"]);
  assert.deepEqual(extractTopLevelWikiLinks(character.fields.find(field => field.name === "alias")!.value), []);

  const ship = result.templates[1]!;
  assert.equal(ship.name, "Ship Box");
  assert.deepEqual(extractTopLevelWikiLinks(ship.fields.find(field => field.name === "captain")!.value), ["Monkey D. Luffy"]);
});

test("preserves duplicate template fields and positional arguments", () => {
  const result = scanTopLevelTemplates("{{Char Box|Main|rank=Captain|rank=Admiral}}", ["char_box"]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.templates[0]!.fields, [
    { name: undefined, value: "Main" },
    { name: "rank", value: "Captain" },
    { name: "rank", value: "Admiral" },
  ]);
});

test("rejects an incomplete infobox but retains only earlier complete templates as diagnostic evidence", () => {
  const incomplete = scanTopLevelTemplates("{{Char Box|affiliation=[[Crew]]", ["Char Box"]);
  assert.equal(incomplete.ok, false);
  if (incomplete.ok) return;
  assert.deepEqual(incomplete.templates, []);
  assert.match(incomplete.error.message, /unclosed template/);

  const laterError = scanTopLevelTemplates("{{Char Box|affiliation=[[Crew]]}} prose {{unfinished", ["Char Box"]);
  assert.equal(laterError.ok, false);
  if (laterError.ok) return;
  assert.equal(laterError.templates.length, 1);
  assert.deepEqual(extractTopLevelWikiLinks(laterError.templates[0]!.fields[0]!.value), ["Crew"]);
});

test("category links remain discoverable after unrelated malformed templates", () => {
  assert.deepEqual(scanCategoryLinks(`{{unclosed example\n[[Category:Grand Line Pirate Crews]]\n<!-- [[Category:Hidden]] -->\n[[:Category:Linked, not assigned]]\n<nowiki>[[Category:Literal]]</nowiki>`), {
    ok: true,
    categories: ["Grand Line Pirate Crews"],
  });
});

test("ignores non-entity namespaces for relations but can retain categories for evidence", () => {
  const markup = "[[Crew]] [[Category:Crew Members]] [[File:Ship.png]] [[Special:Search]]";
  assert.deepEqual(extractTopLevelWikiLinks(markup), ["Crew"]);
  assert.deepEqual(extractTopLevelWikiLinks(markup, { includeNonEntityNamespaces: true }), [
    "Crew", "Category:Crew Members", "File:Ship.png", "Special:Search",
  ]);
  const partial = scanTopLevelWikiLinks("[[Crew]]<!-- unfinished", { includeNonEntityNamespaces: true });
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.links, ["Crew"]);
});
