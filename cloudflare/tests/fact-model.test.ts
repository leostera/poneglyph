import { describe, expect, it } from "vitest";
import { parseFactBatch, parseStoredFact } from "../src/domain/fact.js";
import { parseFactValue } from "../src/domain/fact-value.js";
import { parseFactId, parseStatedAt, parseTransactionId, parseUri } from "../src/domain/identifiers.js";

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("strict fact and identifier parsing", () => {
  it("parses and freezes recursively tagged Rust-compatible values", () => {
    const factValue = value(parseFactValue({
      type: "map",
      value: {
        crew: { type: "list", value: [
          { type: "reference", value: "wiki:person:luffy" },
          { type: "text", value: "Straw Hat" },
        ] },
        active: { type: "boolean", value: true },
      },
    }));

    expect(factValue.type).toBe("map");
    if (factValue.type !== "map") throw new Error("expected a map");
    expect(Object.keys(factValue.value)).toEqual(["active", "crew"]);
    expect(Object.isFrozen(factValue)).toBe(true);
    expect(Object.isFrozen(factValue.value)).toBe(true);
  });

  it("rejects malformed values at the boundary with a useful path", () => {
    const invalid = parseFactValue({
      type: "list",
      value: [{ type: "bytes", value: [0, 256] }],
    });

    expect(invalid.ok).toBe(false);
    if (invalid.ok) throw new Error("invalid value was accepted");
    expect(invalid.error.path).toBe("value.value[0].value[1]");
  });

  it("validates actual calendar dates and RFC 3339 timestamps", () => {
    expect(parseFactValue({ type: "date", value: "2024-02-29" }).ok).toBe(true);
    expect(parseFactValue({ type: "date", value: "2023-02-29" }).ok).toBe(false);
    expect(parseFactValue({ type: "date_time", value: "2026-07-03T10:12:00+00:00" }).ok).toBe(true);
    expect(parseStatedAt("2026-07-03T10:12:00Z").ok).toBe(true);
    expect(parseStatedAt("2026-02-30T10:12:00Z").ok).toBe(false);
  });

  it("distinguishes URIs, fact IDs, transaction IDs, and statement times", () => {
    expect(value(parseUri("wiki:person:luffy"))).toBe("wiki:person:luffy");
    expect(value(parseFactId("poneglyph:fact:1"))).toBe("poneglyph:fact:1");
    expect(value(parseTransactionId("poneglyph:tx:7"))).toBe("poneglyph:tx:7");
    expect(parseUri("not-a-uri").ok).toBe(false);
  });

  it("parses non-empty batches as an all-or-nothing input value", () => {
    const batch = value(parseFactBatch({
      txId: "poneglyph:tx:7",
      facts: [{
        source: "agent:wiki-import",
        entity: "wiki:crew:straw-hats",
        field: "wiki:crew:name",
        value: { type: "text", value: "Straw Hat Pirates" },
        retraction: false,
      }],
    }));

    expect(batch.txId).toBe("poneglyph:tx:7");
    expect(batch.facts).toHaveLength(1);
    expect(Object.isFrozen(batch.facts)).toBe(true);
    expect(parseFactBatch({ txId: "poneglyph:tx:8", facts: [] }).ok).toBe(false);
    expect(parseFactBatch({ txId: "relative", facts: [{}] }).ok).toBe(false);
  });

  it("parses committed facts only when every durable identity is present", () => {
    const stored = value(parseStoredFact({
      factId: "poneglyph:fact:1",
      source: "agent:wiki-import",
      entity: "wiki:crew:straw-hats",
      field: "wiki:crew:name",
      value: { type: "text", value: "Straw Hat Pirates" },
      retraction: false,
      statedAt: "2026-07-03T10:12:00Z",
      txId: "poneglyph:tx:7",
    }));

    expect(stored.factId).toBe("poneglyph:fact:1");
    expect(stored.txId).toBe("poneglyph:tx:7");
    expect(parseStoredFact({ ...stored, txId: undefined }).ok).toBe(false);
  });
});
