import assert from "node:assert/strict";
import type {FactInput} from "@leostera/poneglyph";
import type {Case} from "./small.js";
import type {Query} from "./model.js";

const entity = "test:joined-entity";
const joined: Query = {
  source: 'test:category(Page, "captain"), test:title(Page, Title)',
  atoms: [
    {field: "test:category", entity: {variable: "Page"}, value: {constant: {type: "string", value: "captain"}}},
    {field: "test:title", entity: {variable: "Page"}, value: {variable: "Title"}},
  ],
};

export const queryPlanCases: Case[] = [{name: "query-plan/owner-local-bag-join", async run(s) {
  // The reference model sees only submitted facts, never SQL/evaluator output.
  // 20 x 20 results cross several 128-row SQL pages, with many equal values.
  const categories: FactInput[] = Array.from({length: 20}, (_, index) => ({
    source: `agent:category-${index}`, entity, field: "test:category", value: {type: "text", value: "captain"},
  }));
  const titles: FactInput[] = Array.from({length: 20}, (_, index) => ({
    source: `agent:title-${index}`, entity, field: "test:title",
    value: index === 0 ? {type: "number", value: "9223372036854775807"} : {type: "text", value: "Name"},
  }));
  await s.write("join-seed", [...categories, ...titles,
    {source: "agent:missing-title", entity: "test:missing-title", field: "test:category", value: {type: "text", value: "captain"}},
    {source: "agent:other-owner", entity: "test:another-entity", field: "test:category", value: {type: "text", value: "captain"}},
    {source: "agent:other-owner", entity: "test:another-entity", field: "test:title", value: {type: "null"}},
  ]);
  assert.equal(s.model.query(joined).length, 401);
  await s.query(joined);
  await s.query({...joined, source: joined.source + ', eq(Title, "Name")', filter: row => row["Title"]?.type === "string" && row["Title"].value === "Name"});
  await s.write("join-replace", [categories[0]!]); // Same source tuple replaces, rather than adds multiplicity.
  await s.query(joined);
  await s.write("join-retract", [{...categories[1]!, retraction: true}, {...titles[1]!, retraction: true}]);
  assert.equal(s.model.query(joined).length, 362);
  await s.query(joined);
  await s.query({
    source: 'test:category(Page, "captain"), test:category(Page, Category)',
    atoms: [joined.atoms[0]!, {field: "test:category", entity: {variable: "Page"}, value: {variable: "Category"}}],
  });
}}];
