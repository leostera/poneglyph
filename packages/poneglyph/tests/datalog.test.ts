import { describe, expect, it } from "vitest";
import { parseFactDraft } from "../src/domain/fact.js";
import type { FactDraft } from "../src/domain/fact.js";
import type { FactSource } from "../src/datalog/fact-source.js";
import { parseDatalogQuery } from "../src/datalog/parser.js";
import { evaluateDatalog, QueryResultLimitExceeded, type Binding } from "../src/datalog/evaluator.js";
import { InMemoryFactSource } from "./support/in-memory-fact-source.js";

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function fact(entity: string, field: string, value: unknown, source = "agent:one-piece-test"): FactDraft {
  return unwrap(parseFactDraft({
    source,
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

  it("bounds concurrent final joins and preserves repeated lookup rows", async () => {
    const luffy = "wiki:onepiece:page:luffy";
    const targets = ["Nami", "Zoro", "Robin", "Chopper", "Sanji"];
    const facts = [
      fact(luffy, "wiki:page:title", { type: "text", value: "Monkey D. Luffy" }),
      fact(luffy, "wiki:page:link", { type: "text", value: "Nami" }, "wiki:source:first"),
      fact(luffy, "wiki:page:link", { type: "text", value: "Nami" }, "wiki:source:second"),
      ...targets.slice(1).map((title) => fact(luffy, "wiki:page:link", { type: "text", value: title })),
      ...targets.map((title) => fact(`wiki:onepiece:page:${title.toLowerCase()}`, "wiki:page:title", { type: "text", value: title })),
    ];
    const stored = new InMemoryFactSource(facts);
    let activeFinalScans = 0;
    let maxConcurrentFinalScans = 0;
    let releaseScans!: () => void;
    const scanGate = new Promise<void>((resolve) => { releaseScans = resolve; });
    const scanFallback = setTimeout(releaseScans, 100);
    const source: FactSource = {
      scan(lookup, signal) {
        const finalLookup = lookup.field === "wiki:page:title" && lookup.entity === undefined
          && lookup.value?.type === "string" && lookup.value.value !== "Monkey D. Luffy";
        if (!finalLookup) return stored.scan(lookup, signal);

        activeFinalScans += 1;
        maxConcurrentFinalScans = Math.max(maxConcurrentFinalScans, activeFinalScans);
        if (activeFinalScans === 4) releaseScans();
        return (async function* () {
          try {
            await scanGate;
            yield* stored.scan(lookup, signal);
          } finally {
            activeFinalScans -= 1;
          }
        })();
      },
    };
    const query = unwrap(parseDatalogQuery(
      'wiki:page:title(Page, "Monkey D. Luffy"), wiki:page:link(Page, TargetTitle), wiki:page:title(TargetPage, TargetTitle)',
    ));

    let rows: Binding[];
    try {
      rows = await collect(evaluateDatalog(query, source));
    } finally {
      clearTimeout(scanFallback);
    }
    const triples = rows.map((row) => [stringValue(row, "Page"), stringValue(row, "TargetTitle"), stringValue(row, "TargetPage")]).sort();
    const nami = [luffy, "Nami", "wiki:onepiece:page:nami"];
    expect(triples).toEqual([nami, nami, ...targets.slice(1).map((title) => [luffy, title, `wiki:onepiece:page:${title.toLowerCase()}`])].sort());
    expect(maxConcurrentFinalScans).toBe(4);
    expect(activeFinalScans).toBe(0);
  });

  it("drains a final-scan wave and rejects instead of emitting partial rows on failure", async () => {
    const luffy = "wiki:onepiece:page:luffy";
    const targets = ["Nami", "Zoro", "Robin", "Chopper"];
    const stored = new InMemoryFactSource([
      fact(luffy, "wiki:page:title", { type: "text", value: "Monkey D. Luffy" }),
      ...targets.map((title) => fact(luffy, "wiki:page:link", { type: "text", value: title })),
      ...targets.map((title) => fact(`wiki:onepiece:page:${title.toLowerCase()}`, "wiki:page:title", { type: "text", value: title })),
    ]);
    let settledFinalScans = 0;
    const source: FactSource = {
      scan(lookup, signal) {
        const finalLookup = lookup.field === "wiki:page:title" && lookup.entity === undefined
          && lookup.value?.type === "string" && lookup.value.value !== "Monkey D. Luffy";
        if (!finalLookup) return stored.scan(lookup, signal);
        return (async function* () {
          try {
            await Promise.resolve();
            if (lookup.value?.type === "string" && lookup.value.value === "Robin") throw new Error("injected final-scan failure");
            yield* stored.scan(lookup, signal);
          } finally {
            settledFinalScans += 1;
          }
        })();
      },
    };
    const query = unwrap(parseDatalogQuery(
      'wiki:page:title(Page, "Monkey D. Luffy"), wiki:page:link(Page, TargetTitle), wiki:page:title(TargetPage, TargetTitle)',
    ));
    let emittedRows = 0;

    const run = async () => {
      for await (const _row of evaluateDatalog(query, source)) emittedRows += 1;
    };
    await expect(run()).rejects.toThrow("injected final-scan failure");
    expect(emittedRows).toBe(0);
    expect(settledFinalScans).toBe(4);
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
