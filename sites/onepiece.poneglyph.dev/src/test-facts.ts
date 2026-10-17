import type { FactInput } from "@leostera/poneglyph";

// Synthetic smoke input, NOT extracted/verified wiki data. Keep this identity
// and exact payload together when reconciling an uncertain original delivery.
export const TEST_TX_ID = "playground:seed:20261014-v1";
export const TEST_FACTS: readonly FactInput[] = Object.freeze([
  { source: "fixture:onepiece-playground", entity: "wiki:onepiece:page:Monkey%20D.%20Luffy", field: "wiki:page:title", value: { type: "text", value: "Monkey D. Luffy" } },
  { source: "fixture:onepiece-playground", entity: "wiki:onepiece:page:Monkey%20D.%20Luffy", field: "wiki:page:category", value: { type: "text", value: "Pirates" } },
  { source: "fixture:onepiece-playground", entity: "wiki:onepiece:page:Monkey%20D.%20Luffy", field: "wiki:page:link", value: { type: "text", value: "Roronoa Zoro" } },
  { source: "fixture:onepiece-playground", entity: "wiki:onepiece:page:Monkey%20D.%20Luffy", field: "wiki:page:namespace", value: { type: "number", value: "0" } },
  { source: "fixture:onepiece-playground", entity: "wiki:onepiece:page:Monkey%20D.%20Luffy", field: "wiki:page:text_bytes", value: { type: "number", value: "140" } },
  { source: "fixture:onepiece-playground", entity: "wiki:onepiece:page:Roronoa%20Zoro", field: "wiki:page:title", value: { type: "text", value: "Roronoa Zoro" } },
]);
