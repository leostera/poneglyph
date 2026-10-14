import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyOnePiecePage, extractPageEnrichment, identityFacts } from "../onepiece-enrichment.js";
import { onePieceEntityForPage, parseWikiPageId } from "../onepiece-identities.js";
import { WikiPageDirectory, type WikiPageReference } from "../wiki-page-directory.js";
import type { WikiDumpPage } from "../wiki-xml.js";

const corpusSha256 = "a".repeat(64);
function id(value: string) {
  const parsed = parseWikiPageId(value);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}
function page(input: Omit<WikiDumpPage, "id"> & { id: string }): WikiDumpPage {
  return { ...input, id: id(input.id) };
}

test("classifies explicit character, ship, and crew evidence and reports conflicts", () => {
  assert.equal(classifyOnePiecePage(page({ id: "10", title: "Gol D. Roger", namespace: "0", text: "{{Char Box|name=Roger}}" })).kind, "character");
  assert.equal(classifyOnePiecePage(page({ id: "11", title: "Going Merry", namespace: "0", text: "{{Ship Box|name=Merry}}" })).kind, "ship");
  assert.equal(classifyOnePiecePage(page({ id: "14", title: "Roger Pirates", namespace: "0", text: "{{Crew Box|captain=[[Gol D. Roger]]}}" })).kind, "crew");
  assert.equal(classifyOnePiecePage(page({ id: "12", title: "Roger Pirates", namespace: "0", text: "{{broken example\n[[Category:Grand Line Pirate Crews]]" })).kind, "crew");
  assert.equal(classifyOnePiecePage(page({ id: "15", title: "Monkey D. Luffy", namespace: "0", text: "[[Category:Foosha Village Characters]]" })).kind, "character");
  assert.equal(classifyOnePiecePage(page({ id: "16", title: "Oro Jackson", namespace: "0", text: "[[Category:Roger Pirates' Ships]]" })).kind, "ship");

  const conflict = classifyOnePiecePage(page({
    id: "13", title: "Conflicting Evidence", namespace: "0",
    text: "{{Char Box|name=x}}\n[[Category:Grand Line Pirate Crews]]",
  }));
  assert.equal(conflict.kind, "entity");
  assert.equal(conflict.issues[0]?.kind, "identity-conflict");
});

test("extracts only explicit infobox links and member-category claims into UID references", () => {
  const sourcePage = page({
    id: "10", title: "Gol D. Roger", namespace: "0",
    text: `{{Char Box
|affiliation=[[Roger Pirates]];{{Qref|note=[[not an affiliation]]}} [[Will of D.]]
|occupation=[[Pirate Captain]]
}}
[[Category:Roger Pirates Members]]`,
  });
  const targets = [
    { id: id("20"), title: "Roger Pirates", namespace: "0" },
    { id: id("21"), title: "Roger Crew", namespace: "0", redirectTarget: "Roger Pirates" },
    { id: id("30"), title: "Will of D.", namespace: "0" },
    { id: id("40"), title: "Pirate Captain", namespace: "0" },
  ] satisfies readonly WikiPageReference[];
  const directory = new WikiPageDirectory();
  const sourceReference = { id: sourcePage.id, title: sourcePage.title, namespace: sourcePage.namespace };
  directory.add(sourceReference);
  for (const target of targets) directory.add(target);
  const kinds = new Map<string, "character" | "crew" | "entity" | "role">([
    ["10", "character"], ["20", "crew"], ["30", "entity"], ["40", "role"],
  ]);

  const result = extractPageEnrichment(sourcePage, directory, kinds, corpusSha256);
  assert.equal(result.issues.length, 0);
  assert.equal(result.facts.length, 4);
  assert.deepEqual(result.facts.map(fact => [fact.field, fact.value]), [
    ["onepiece:affiliation", { type: "reference", value: onePieceEntityForPage("crew", id("20")) }],
    ["onepiece:affiliation", { type: "reference", value: onePieceEntityForPage("entity", id("30")) }],
    ["onepiece:occupation", { type: "reference", value: onePieceEntityForPage("role", id("40")) }],
    ["onepiece:member_of", { type: "reference", value: onePieceEntityForPage("crew", id("20")) }],
  ]);
  assert.equal(result.facts[0]!.entity, onePieceEntityForPage("character", id("10")));
  assert.equal(result.facts[0]!.source, `wiki:onepiece:derived:${corpusSha256}:relations-v5:10:Char%20Box:affiliation`);
  assert.deepEqual(result.referencedPages.map(target => target.id), [id("20"), id("30"), id("40"), id("10")]);
});

test("records duplicate claims, unresolved targets, and plain-text values instead of guessing", () => {
  const sourcePage = page({
    id: "10", title: "Unknown Captain", namespace: "0",
    text: "{{Char Box|affiliation=[[Known Crew]] [[Known Crew]] [[Missing Crew]] [[Missing Crew]]|occupation=Pirate}}",
  });
  const directory = new WikiPageDirectory();
  directory.add({ id: sourcePage.id, title: sourcePage.title, namespace: "0" });
  directory.add({ id: id("20"), title: "Known Crew", namespace: "0" });
  const result = extractPageEnrichment(sourcePage, directory, new Map([["10", "character"], ["20", "crew"]]), corpusSha256);
  assert.equal(result.facts.length, 1);
  assert.equal(result.issues.filter(issue => issue.kind === "unresolved-link").length, 2);
  assert.equal(result.issues.filter(issue => issue.kind === "duplicate-claim").length, 1);
  assert.equal(result.issues.filter(issue => issue.kind === "unsupported-value").length, 1);
});

test("extracts crew captain and ship relations from Crew Box fields", () => {
  const crewPage = page({
    id: "50", title: "Roger Pirates", namespace: "0",
    text: "{{Crew Box|captain=[[Gol D. Roger]]|ship=[[Oro Jackson]]}}",
  });
  const captain = { id: id("51"), title: "Gol D. Roger", namespace: "0" };
  const ship = { id: id("52"), title: "Oro Jackson", namespace: "0" };
  const directory = new WikiPageDirectory();
  directory.add({ id: crewPage.id, title: crewPage.title, namespace: crewPage.namespace });
  directory.add(captain);
  directory.add(ship);
  const kinds = new Map<string, "crew" | "character" | "ship">([
    ["50", "crew"], ["51", "character"], ["52", "ship"],
  ]);

  const result = extractPageEnrichment(crewPage, directory, kinds, corpusSha256);
  assert.deepEqual(result.facts.map(fact => [fact.field, fact.value]), [
    ["onepiece:captain", { type: "reference", value: onePieceEntityForPage("character", captain.id) }],
    ["onepiece:ship", { type: "reference", value: onePieceEntityForPage("ship", ship.id) }],
  ]);
});

test("category affiliations resolve to a typed crew UID and distinguish former members", () => {
  const person = page({ id: "10", title: "Former Pirate", namespace: "0", text: "[[Category:Former Roger Pirates]]" });
  const crew = { id: id("20"), title: "Roger Pirates", namespace: "0" };
  const directory = new WikiPageDirectory();
  directory.add({ id: person.id, title: person.title, namespace: person.namespace });
  directory.add(crew);
  const result = extractPageEnrichment(person, directory, new Map([["10", "character"], ["20", "crew"]]), corpusSha256);
  assert.deepEqual(result.facts.map(fact => [fact.field, fact.value]), [[
    "onepiece:former_member_of", { type: "reference", value: onePieceEntityForPage("crew", crew.id) },
  ]]);
});

test("maps exact crew categories and ship categories only when their typed target resolves", () => {
  const crew = { id: id("20"), title: "Roger Pirates", namespace: "0" };
  const person = page({ id: "21", title: "Rayleigh", namespace: "0", text: "[[Category:Roger Pirates]]" });
  const ship = page({ id: "22", title: "Oro Jackson", namespace: "0", text: "[[Category:Roger Pirates' Ships]]" });
  const directory = new WikiPageDirectory();
  directory.add(crew);
  directory.add({ id: person.id, title: person.title, namespace: person.namespace });
  directory.add({ id: ship.id, title: ship.title, namespace: ship.namespace });
  const kinds = new Map<string, "crew" | "character" | "ship">([
    ["20", "crew"], ["21", "character"], ["22", "ship"],
  ]);

  const personResult = extractPageEnrichment(person, directory, kinds, corpusSha256);
  const shipResult = extractPageEnrichment(ship, directory, kinds, corpusSha256);
  assert.deepEqual(personResult.facts.map(fact => fact.field), ["onepiece:member_of"]);
  assert.deepEqual(shipResult.facts.map(fact => fact.field), ["onepiece:affiliation"]);
  assert.equal(shipResult.facts[0]!.value.type, "reference");
  if (shipResult.facts[0]!.value.type === "reference") {
    assert.equal(shipResult.facts[0]!.value.value, onePieceEntityForPage("crew", crew.id));
  }
});

test("uses redirects as aliases on the canonical semantic UID", () => {
  const canonical: WikiPageReference = { id: id("20"), title: "Roger Pirates", namespace: "0" };
  const redirectPage = page({ id: "21", title: "Roger Crew", namespace: "0", text: "#REDIRECT [[Roger Pirates]]", redirectTarget: "Roger Pirates" });
  const directory = new WikiPageDirectory();
  directory.add(canonical);
  directory.add(redirectPage);
  const result = extractPageEnrichment(redirectPage, directory, new Map([["20", "crew"]]), corpusSha256);
  assert.deepEqual(result.facts.map(fact => [fact.entity, fact.field, fact.value]), [[
    onePieceEntityForPage("crew", id("20")), "onepiece:alias", { type: "text", value: "Roger Crew" },
  ]]);
  assert.deepEqual(result.referencedPages, [canonical]);
});

test("semantic identity records source-page evidence separately from its UID", () => {
  const source: WikiPageReference = { id: id("1439"), title: "Straw Hat Pirates", namespace: "0" };
  const facts = identityFacts(source, "crew", corpusSha256);
  assert.equal(facts[0]!.entity, onePieceEntityForPage("crew", source.id));
  assert.deepEqual(facts.map(fact => fact.field), [
    "onepiece:name", "onepiece:kind", "onepiece:source_page", "onepiece:source_page_id",
  ]);
  assert.deepEqual(facts[2]!.value, { type: "reference", value: "wiki:onepiece:page:Straw%20Hat%20Pirates" });
});
