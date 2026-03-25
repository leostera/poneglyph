# MCP Feedback

## Resolved Issues

### 1. Quoted predicates not supported (RESOLVED)
- **Problem**: Query parser didn't support predicates with special characters like `/` (e.g., `local://schema/name`)
- **Error**: `query parse failed` with no helpful message
- **Fix**: Added single-quoted predicate syntax (`'local://schema/name'`)
- **Date**: 2026-03-13

### 2. createEntity tool (RESOLVED)
- **Added**: `createEntity(namespace, kind, name)` tool
- **Returns**: Entity URI (e.g., `dev:project:032HJb6y7SlDSWhok7W2QC`)
- **Auto-adds**: `schema:name` fact with the provided name
- **Date**: 2026-03-14

### 3. Spotify-style Entity IDs (RESOLVED)
- **Pattern**: UUIDv7 → base62 encoding
- **Result**: 22 character compact, sortable IDs
- **Example**: `dev:project:032HJb6y7SlDSWhok7W2QC`
- **Date**: 2026-03-14

---

## Open Issues

### 2. Error messages lack context
- **Problem**: "query parse failed" gives no hint about expected syntax
- **Suggestion**: Include example valid queries in error messages

### 3. URI format not documented
- **Problem**: No guidance on valid URI format for entities/fields
- **Error**: "relative URL without a base" without showing valid format
- **Suggestion**: Add `schema` or `describe` endpoint to list available patterns

### 4. JSON encoding issue with large fact batches
- **Problem**: Sending many facts at once results in JSON encoding errors
- **Error**: `invalid type: string ... expected a sequence`
- **Workaround**: Send facts in smaller batches (5-7 at a time)
- **Status**: Still an issue - request timeouts occur with larger batches

### 5. Lists stored as JSON strings
- **Problem**: List values are stored as JSON strings, making queries for individual list items fail
- **Example**: `'spotify:genre'(Artist, "Progressive rock")` returns no results even though the entity has "Progressive rock" in its genre list
- **Suggestion**: Either store lists as separate facts, or improve query matching to handle list membership

## Usability Suggestions

### 1. Add help/examples tool
- Return usage patterns and example queries

### 2. Improve tool descriptions
- Include sample valid inputs in tool definitions

### 3. Field naming guidance
- Show available field naming patterns or allow simpler field names

### 4. Namespace conventions documentation
- **Current approach**: Use domain names as namespaces (e.g., `spotify:`, `imdb:`, `rushfandom:`, `leostera:`)
- This works well and feels natural

---

# Fact Extraction Notes

## What makes fact extraction easier

### 1. Structured source data
- Wikipedia pages are well-structured with clear sections (History, Discography, Band members, etc.)
- Infoboxes provide quick key-value facts
- Clear headings make it easy to identify topic areas

### 2. Clear entity relationships
- Facts about a band: name, origin, genre, members
- Facts about a person: name, birth date, role, relationship to entity
- Well-defined schemas help map to consistent fields

### 3. Batch size matters
- Sending facts in smaller batches (5-7) works reliably
- Large batches cause JSON encoding issues
- It's better to err on the side of smaller transactions

### 4. URI namespace strategy
- Using domain names as namespace prefixes is intuitive
- Examples: `spotify:artist:rush`, `imdb:artist:rush`, `leostera:person:leo`
- Field names follow same pattern: `spotify:name`, `leostera:job`, etc.

### 5. What doesn't work well
- Free-form text without clear structure
- Ambiguous facts where subject is unclear
- Sources that mix multiple entities without clear separation

### 6. Query limitations discovered
- Can't query for items within lists (e.g., finding artists by genre)
- Constant values in queries don't match against stored list values
- Need separate facts for each list item to enable flexible querying

### 7. Entity references via URIs
- **Feature**: Can use URIs as values to create references between entities
- **Example**: `leostera:favoriteBand` = `spotify:artist:rush` (links person to band entity)
- **Benefit**: Enables graph traversal and relational queries

### 8. Multi-hop queries DO work!
- **Discovery**: Conjunctive queries with commas work perfectly
- **Example**: `'leostera:favoriteBand'(Person, Band), 'spotify:leadSinger'(Band, Singer), 'spotify:origin'(Singer, City)`
- **Result**: Returns joined data across 3 hops (Person → Band → Singer → City)
- This is a powerful feature!

---

# Schema Design Guidance

## Entity relationships via references
- Use `reference` type to link entities
- Add explicit fields for traversal (e.g., `leadSinger` on band, linking to person entity)
- This enables single-query graph traversal

## Recommended fields for graph queries
- `band:leadSinger` → reference to person entity
- `person:band` → reference to band entity
- `person:favoriteBand` → reference to band entity

---

# Schema Definition Experience

## What works well

### 1. Hierarchical namespace naming
- `code:rust:crate`, `code:typescript:package`, `github:repository` - intuitive and organized
- Using `:` as separator keeps URIs readable
- Allows grouping by language: `code:rust:*`, `code:typescript:*`

### 2. Field URIs are self-documenting
- `dev:path`, `github:stars`, `git:sha` - no need for extra `name` field
- The URI itself tells you what it means
- Only add custom `doc` when the meaning is non-obvious

### 3. Using `schema:field:domain` restricts fields to specific kinds
- `dev:platform` with domain `dev:project` makes sense
- Prevents accidental misuse

### 4. Reference types for entity relationships
- Use `reference` value type for fields that point to other entities
- Enables graph traversal in queries

## Issues discovered

### 1. Schema definition is verbose
- Each namespace requires: `schema:type`, `schema:name`, `schema:doc`
- Each kind requires: `schema:type`, `schema:name`, `schema:doc`
- Each field requires: `schema:type`, `schema:name`, `schema:doc`, `schema:field:valueType`, optionally `schema:field:domain`
- **Suggestion**: Add a `schema:define` bulk API to reduce round trips

### 2. getSchema returns incomplete metadata for new entries
- New namespaces show up but `name` and `doc` sometimes appear as `null`
- The data was written (can see it when fetching individual entities)
- May be a filtering issue in `getSchema`

### 3. Field definitions need domain to be useful
- Without `schema:field:domain`, fields apply to any entity
- Consider making domain required or defaulting to the namespace

### 4. No way to verify schema was added correctly
- getSchema returns all fields but doesn't confirm which are user-defined
- Could add a `schema:userDefined` flag or separate user/base sections

## Recommended schema definition pattern

```
Namespace: <namespace>:namespace
  - schema:type → schema:namespace
  - schema:name → "Display Name"
  - schema:doc → "Description"

Kind: <namespace>:<entity>
  - schema:type → schema:kind
  - schema:name → "Display Name"
  - schema:doc → "Description"

Field: <namespace>:<field>
  - schema:type → schema:field
  - schema:name → "Display Name"
  - schema:doc → "Description" (optional if URI is obvious)
  - schema:field:valueType → text | number | boolean | reference | list | date
  - schema:field:domain → <namespace>:<entity> (optional)
```

---

# Entity URI Design

## Schema vs Instance URIs

### Schema (fixed, human-readable)
- Kinds: `dev:project`, `code:rust:crate`, `github:repository`
- Fields: `dev:path`, `github:stars`, `git:sha`
- These are predictable and few in number

### Entities (many, need uniqueness)
- **Implemented**: Spotify-style base62 IDs from UUIDv7
- Example: `dev:project:032HJb6y7SlDSWhok7W2QC`
- 22 chars, sortable, URL-safe

## Recommended: Search-first workflow

1. **Create entity with UUID**
   ```
   Entity: dev:project:019ceba0-...
   Facts: 
     dev:name → "poneglyph"
     dev:path → "./crates/poneglyph"
   ```

2. **Later, want to add facts?**
   ```
   search("poneglyph") → "dev:project:019ceba0-..."
   state_facts(entity: "dev:project:019ceba0-...", field: "dev:status", value: "active")
   ```

3. **Never memorize the UUID** - the graph returns it when you need it

## Why this works
- Schema URIs are few and memorable
- Entity URIs are many and auto-generated
- Search is your lookup mechanism
- Display names live in facts, not URIs

## Spotify-style Entity IDs (IMPLEMENTED)

Inspired by Spotify's `spotify:track:6rqhFgbbKwnb9MLmUQDhG6` format:

### The pattern (Now live!)
1. Generate UUIDv7 (128-bit, embedded timestamp)
2. Encode as base62 (0-9, a-z, A-Z)
3. Result: ~22 character compact, sortable IDs

### Example implementation (Deno - Now live!)

```typescript
import { v7 as uuidv7, parse as parseUuid } from "npm:uuid";

const BASE62_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function bytesToBase62(bytes: Uint8Array, minLength = 22): string {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  if (value === 0n) return BASE62_ALPHABET[0].repeat(minLength);
  
  let out = "";
  const base = 62n;
  while (value > 0n) {
    const rem = Number(value % base);
    out = BASE62_ALPHABET[rem] + out;
    value /= base;
  }
  return out.padStart(minLength, "0");
}

export function generateEntityId(): string {
  const uuid = uuidv7();
  const bytes = parseUuid(uuid); // Uint8Array(16)
  return bytesToBase62(bytes, 22);
}
```

### Result

```
UUIDv7:   019cebb5-08d6-741e-97c7-3b1924b02b6a
EntityID: 032HJb6y7SlDSWhok7W2QC

Full URI: dev:project:032HJb6y7SlDSWhok7W2QC
```

### Benefits
- **Compact**: 22 chars vs 36 for UUID
- **Sortable**: Timestamps embedded (UUIDv7)
- **URL-safe**: Base62 uses alphanumeric only
- **Spotify-compatible**: Same encoding strategy

## Entity Creation API (IMPLEMENTED)

### createEntity tool

```
Tool: createEntity
Args: namespace, kind, name
Returns: { entityUri: "dev:project:032HJb...", txId: "..." }
Auto-adds: schema:name → "my-cool-project"
```

### Why require name?
- **No zombie entities**: Every entity has at least one searchable attribute
- **Guaranteed findability**: Can always search by name
- **Auditability**: Know what's in your graph

### Workflow: Search then create

```
# Find entity first
search("my-project") 
→ Returns hits with scores + fields
→ LLM picks best match based on data

# Only create if not found
createEntity("dev", "project", "my-project")
→ Returns { entityUri, txId }
```

### Tool signatures (Implemented)

```
createEntity(namespace: string, kind: string, name: string) → { entityUri, txId }

search(query: string) → { hits: [{ entity_uri, score }] }

getEntity(entityUri) → { entity: { uri, kind, namespace, fields } }

stateFacts({ entities: string[], facts: Fact[] }) → txId
  // Validates all entities exist before adding facts
```

Note: `createEntity` now returns the entityUri directly, solving the original feedback.

---

# MCP Developer Experience (2026-03-24)

## Context
Attempted to add date range query support (e.g., "events from March 2026") to the Datalog query parser in the `datafox` crate.

## What I tried to do
1. Add comparison operators (`>=`, `<=`, `>`, `<`, `=`) to the lexer
2. Support prefix syntax: `>(Start, "2026-01-01")` 
3. Support infix syntax: `Start >= "2026-01-01"` (preferred by user)

## What went wrong

### Issue 1: State confusion
The codebase appeared reverted - parser didn't have operator tokens, evaluator returned `UnsupportedBuiltin` for all builtins. Prior work apparently lost or never committed.

### Issue 2: Code corruption during edits
Multiple attempts to add infix syntax (`X > Y`) to the parser resulted in corrupted code - the parser logic got mangled due to complex borrow checker interactions. Each attempt required reverting to a working state.

### Issue 3: No visibility into prior state
Had no way to see what the "working" implementation looked like before it was reverted. Couldn't learn from prior mistakes.

## What worked
- Prefix operator parsing (`>(X, 42)`) was implemented in prior work
- Named builtins (`gt`, `gte`, `lt`, `lte`, `equal`) in the evaluator work

## Suggestions

### 1. Preserve work-in-progress branches
- Don't revert incomplete features to main - use feature branches
- Tag experiments clearly so it's obvious what's experimental vs stable

### 2. Add instrumentation to MCP server
- Log what parser/evaluator receives and returns
- Makes debugging easier when things go wrong

### 3. Self-contained feature tests
- Add tests that exercise the full MCP → parser → evaluator pipeline
- Would catch regressions like the "no operator tokens" state

### 4. Document parser architecture
- Current parser is hand-written in `crates/datafox/src/parser.rs`
- Knowing it's a custom lexer/parser (not using pest/lalrpop) helps set expectations
- Understanding TokenKind enum structure would help future work
