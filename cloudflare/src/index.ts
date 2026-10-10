export * from "./domain/fact.js";
export * from "./domain/fact-value.js";
export * from "./domain/identifiers.js";
export * from "./datalog/ast.js";
export * from "./datalog/evaluator.js";
export * from "./datalog/fact-source.js";
export * from "./datalog/parser.js";
export * from "./datalog/value.js";

export default {
  fetch(): Response {
    return new Response("Not Found", { status: 404 });
  },
};
