export const QUERY_PREDICATE_INVENTORY = Object.freeze([
  {field: "wiki:page:title", valueType: "string", description: "Exact page title; values are strings, not entity references."},
  {field: "wiki:page:namespace", valueType: "integer", description: "MediaWiki namespace number."},
  {field: "wiki:page:text_bytes", valueType: "integer", description: "Original wikitext UTF-8 byte length; article text itself is not stored."},
  {field: "wiki:page:category", valueType: "string", description: "Category title; one active relation tuple per extracted category."},
  {field: "wiki:page:link", valueType: "string", description: "Link target title, not an entity reference."},
] as const);

export const QUERY_RUBRIC = Object.freeze({
  predicateFields: QUERY_PREDICATE_INVENTORY,
  dataScope: "The five fields above are the normalized One Piece corpus vocabulary. The generic engine accepts any valid URI predicate; an unknown predicate is not a schema error and normally has no matching facts. The semantic enrichment overlay and its extra predicates are not hosted.",
  relation: {
    form: "field(Entity, Value)",
    arity: 2,
    positiveRelationsRequired: 1,
    totalClauseLimit: 64,
  },
  bindings: Object.freeze([
    {id: "entity-and-value-constant", entity: "constant", value: "constant", expectedAccess: "exact lookup; entity route can select one tree root"},
    {id: "entity-constant-value-variable", entity: "constant", value: "variable", expectedAccess: "enumerate values for one entity and field"},
    {id: "entity-variable-value-constant", entity: "variable", value: "constant", expectedAccess: "value search across eligible leaves"},
    {id: "both-variables", entity: "variable", value: "variable", expectedAccess: "full relation scan; subject to tuple/result/byte/fanout budgets"},
    {id: "wildcard-terms", entity: "wildcard-or-bound", value: "wildcard-or-bound", expectedAccess: "wildcards do not bind or appear in result rows"},
  ] as const),
  terms: Object.freeze([
    "Uppercase-leading identifiers are variables.",
    "Underscore is a wildcard and never appears in results.",
    "JSON double-quoted strings and single-quoted identifiers produce string constants.",
    "Signed 64-bit integer literals produce integer constants; integers and strings are distinct typed values.",
    "Bare lowercase URI-like identifiers are string constants; relation names are valid URI predicates.",
  ] as const),
  builtins: Object.freeze([
    {family: "equality", spellings: ["=", "eq"], semantics: "Same Datalog type and exact value."},
    {family: "less-than", spellings: ["<", "lt", "before"], semantics: "Typed ordering; Unicode-scalar string order or signed-64 integer order."},
    {family: "less-than-or-equal", spellings: ["<=", "lte"], semantics: "Typed ordering; incompatible types do not match."},
    {family: "greater-than", spellings: [">", "gt", "after"], semantics: "Typed ordering; Unicode-scalar string order or signed-64 integer order."},
    {family: "greater-than-or-equal", spellings: [">=", "gte"], semantics: "Typed ordering; incompatible types do not match."},
    {family: "contains", spellings: ["contains"], semantics: "First string contains the second string."},
    {family: "starts-with", spellings: ["startsWith"], semantics: "First string begins with the second string."},
    {family: "ends-with", spellings: ["endsWith"], semantics: "First string ends with the second string."},
  ] as const),
  composition: Object.freeze([
    "Comma-separated conjunction; source clause order is retained except for documented bounded physical operators.",
    "Variables shared across relations perform typed unification; repeated variables in one relation require equal typed terms.",
    "One relation plus builtin constraints is supported; every builtin variable must be bound by a positive fact relation.",
    "Two-relation same-entity joins and bounded multi-hop joins are supported; link values are title strings, so resolving a link requires a title relation join.",
    "Rows have bag semantics: repeated fact combinations produce repeated rows; rows are unordered and complete or the query fails.",
  ] as const),
  physicalOperators: Object.freeze([
    "Two clauses with a constant first value and the same entity variable can use an owner-local SQL bag join.",
    "A three-clause final value-to-entity join has a bounded four-scan concurrent wave for the recognized plan shape.",
    "A single positive relation with a valid literal entity URI leases only that entity's tree root; joins and unbound entities use the complete read vector.",
  ] as const),
  unsupported: Object.freeze([
    "No negation, disjunction, rule definitions, recursive rules, aggregation, projection, ordering, LIMIT, OFFSET, or pagination.",
    "No full article text, semantic enrichment predicates, inference, or schema constraints are provided by this hosted corpus.",
  ] as const),
  budgets: Object.freeze({queryCharacters: 8192, clauses: 64, resultRows: 2000, tuplesRead: 50000, shardRequests: 20000, scanBytes: 20000000, databaseResponseBytes: 2000000, durationSeconds: 20, leafFanout: 256, directoryNodes: 511}),
});
