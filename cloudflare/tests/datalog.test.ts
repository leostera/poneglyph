import { describe, expect, it } from "vitest";
import { parseFactDraft } from "../src/domain/fact.js";
import type { FactDraft } from "../src/domain/fact.js";
import { parseDatalogQuery } from "../src/datalog/parser.js";
import { evaluateDatalog, QueryResultLimitExceeded, type Binding } from "../src/datalog/evaluator.js";
import { InMemoryFactSource } from "./support/in-memory-fact-source.js";

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function fact(entity: string, field: string, value: unknown): FactDraft {
  return unwrap(parseFactDraft({
    source: "agent:one-piece-test",
    entity,
    field,
    value,
    retraction: false,
  }));
}

function stringValue(binding: Binding, variable: string): string {
  const value = binding.get(variable);
  if (value?.type !== "string") throw new Error(`expected string binding for ${variable}`);
  return value.value;
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

const onePieceFacts = [
  fact("wiki:crew:straw-hats", "wiki:crew:captain", { type: "reference", value: "wiki:person:luffy" }),
  fact("wiki:crew:straw-hats", "wiki:crew:second", { type: "reference", value: "wiki:person:zoro" }),
  fact("wiki:person:luffy", "wiki:person:name", { type: "text", value: "Monkey D. Luffy" }),
  fact("wiki:person:zoro", "wiki:person:name", { type: "text", value: "Roronoa Zoro" }),
  fact("wiki:crew:blackbeard", "wiki:crew:captain", { type: "reference", value: "wiki:person:teach" }),
  fact("wiki:crew:blackbeard", "wiki:crew:second", { type: "reference", value: "wiki:person:shiryu" }),
  fact("wiki:person:teach", "wiki:person:name", { type: "text", value: "Marshall D. Teach" }),
  fact("wiki:person:shiryu", "wiki:person:name", { type: "text", value: "Shiryu" }),
];

describe("bounded positive Datalog subset", () => {
  it("parses the current Poneglyph relation syntax and string builtins", () => {
    const query = unwrap(parseDatalogQuery(
      'wiki:crew:captain(Crew, Captain), wiki:person:name(Captain, Name), contains(Name, "Monkey")',
    ));

    expect(query.facts).toHaveLength(2);
    expect(query.constraints).toHaveLength(1);
    expect(query.constraints[0]?.name).toBe("contains");
  });

  it("executes a multi-hop One Piece crew/name query and pushes bound entity keys down", async () => {
    const source = new InMemoryFactSource(onePieceFacts);
    const query = unwrap(parseDatalogQuery(
      'wiki:crew:captain(Crew, Captain), wiki:crew:second(Crew, Second), ' +
      'wiki:person:name(Captain, CaptainName), wiki:person:name(Second, SecondName), ' +
      'contains(CaptainName, "Monkey")',
    ));

    const rows = await collect(evaluateDatalog(query, source));
    expect(rows).toHaveLength(1);
    expect(stringValue(rows[0]!, "Crew")).toBe("wiki:crew:straw-hats");
    expect(stringValue(rows[0]!, "CaptainName")).toBe("Monkey D. Luffy");
    expect(stringValue(rows[0]!, "SecondName")).toBe("Roronoa Zoro");

    expect(source.lookups[0]?.field).toBe("wiki:crew:captain");
    expect(source.lookups).toContainEqual({
      field: "wiki:crew:second",
      entity: { type: "string", value: "wiki:crew:straw-hats" },
    });
    expect(source.lookups).toContainEqual({
      field: "wiki:person:name",
      entity: { type: "string", value: "wiki:person:luffy" },
    });
  });

  it("matches the existing One Piece D. name query and prefix/suffix constraints", async () => {
    const source = new InMemoryFactSource([
      fact("wiki:person:luffy", "wiki:page:type", { type: "text", value: "character" }),
      fact("wiki:person:luffy", "wiki:page:title", { type: "text", value: "Monkey D. Luffy" }),
      fact("wiki:person:law", "wiki:page:type", { type: "text", value: "character" }),
      fact("wiki:person:law", "wiki:page:title", { type: "text", value: "Trafalgar D. Water Law" }),
      fact("wiki:person:zoro", "wiki:page:type", { type: "text", value: "character" }),
      fact("wiki:person:zoro", "wiki:page:title", { type: "text", value: "Roronoa Zoro" }),
    ]);
    const nameQuery = unwrap(parseDatalogQuery(
      'wiki:page:type(Person, "character"), wiki:page:title(Person, Name), contains(Name, " D. ")',
    ));
    const nameRows = await collect(evaluateDatalog(nameQuery, source));
    expect(nameRows.map((row) => stringValue(row, "Name")).sort()).toEqual([
      "Monkey D. Luffy",
      "Trafalgar D. Water Law",
    ]);

    const prefixSuffixQuery = unwrap(parseDatalogQuery(
      'wiki:page:title(Person, Name), startsWith(Name, "Monkey"), endsWith(Name, "Luffy")',
    ));
    expect(await collect(evaluateDatalog(prefixSuffixQuery, source))).toHaveLength(1);
  });

  it("explodes list-valued facts into one relation tuple per item", async () => {
    const source = new InMemoryFactSource([
      fact("wiki:crew:straw-hats", "wiki:crew:aliases", {
        type: "list",
        value: [
          { type: "text", value: "Straw Hats" },
          { type: "text", value: "Mugiwara" },
        ],
      }),
    ]);
    const query = unwrap(parseDatalogQuery('wiki:crew:aliases(Crew, "Mugiwara")'));

    const rows = await collect(evaluateDatalog(query, source));
    expect(rows).toHaveLength(1);
    expect(stringValue(rows[0]!, "Crew")).toBe("wiki:crew:straw-hats");
  });

  it("enforces repeated-variable joins and typed integer comparisons", async () => {
    const source = new InMemoryFactSource([
      fact("wiki:person:luffy", "wiki:person:parent", { type: "reference", value: "wiki:person:dragon" }),
      fact("wiki:person:luffy", "wiki:person:age", { type: "number", value: "19" }),
      fact("wiki:person:dragon", "wiki:person:age", { type: "number", value: "55" }),
    ]);
    const query = unwrap(parseDatalogQuery(
      'wiki:person:parent(Person, Parent), wiki:person:age(Person, Age), Age >= 18',
    ));

    const rows = await collect(evaluateDatalog(query, source));
    expect(rows).toHaveLength(1);
    expect(stringValue(rows[0]!, "Person")).toBe("wiki:person:luffy");
    expect(rows[0]?.get("Age")).toEqual({ type: "integer", value: "19" });

    const repeated = unwrap(parseDatalogQuery('wiki:person:parent(Person, Person)'));
    expect(await collect(evaluateDatalog(repeated, source))).toHaveLength(0);
  });

  it("rejects unsafe, unsupported, and unbounded query forms during parsing", () => {
    expect(parseDatalogQuery("contains(Name, \"D.\")").ok).toBe(false);
    expect(parseDatalogQuery("!wiki:crew:captain(Crew, Captain)").ok).toBe(false);
    expect(parseDatalogQuery("wiki:crew:captain(Crew)").ok).toBe(false);
    expect(parseDatalogQuery("wiki:crew:captain(Crew, Captain), Captain > Unknown").ok).toBe(false);
    expect(parseDatalogQuery("wiki:crew:captain(Crew, Captain), contains(_, \"D.\")").ok).toBe(false);
    expect(parseDatalogQuery("wiki:crew:captain(Crew, Captain), matchesRegex(Captain, \".*\")").ok).toBe(false);
  });

  it("streams results and enforces a caller-visible result cap", async () => {
    const source = new InMemoryFactSource([
      fact("wiki:person:luffy", "wiki:person:name", { type: "text", value: "Monkey D. Luffy" }),
      fact("wiki:person:zoro", "wiki:person:name", { type: "text", value: "Roronoa Zoro" }),
    ]);
    const query = unwrap(parseDatalogQuery("wiki:person:name(Person, Name)"));
    const rows = evaluateDatalog(query, source, { maxResults: 1 });

    await expect(collect(rows)).rejects.toBeInstanceOf(QueryResultLimitExceeded);
  });
});
