import { describe, expect, it } from "vitest";
import { ensureCoordinatorSchema, ensureShardSchema } from "../src/storage/sql.js";

type SchemaInitializer = (storage: DurableObjectStorage) => void;

const initializers: readonly Readonly<{
  kind: string;
  existingTable: string;
  initialize: SchemaInitializer;
}>[] = [
  { kind: "coordinator", existingTable: "graph_state", initialize: ensureCoordinatorSchema },
  { kind: "shard", existingTable: "shard_identity", initialize: ensureShardSchema },
];

describe("Durable Object schema compatibility", () => {
  it.each(initializers)("refuses to reinterpret an unversioned $kind database before running DDL", ({ existingTable, initialize }) => {
    const statements: string[] = [];
    const storage = {
      transactionSync: (callback: () => unknown) => callback(),
      sql: {
        exec: (statement: string) => {
          statements.push(statement);
          if (statement.includes("name = 'poneglyph_schema'")) return { toArray: () => [] };
          if (statement.includes("name NOT LIKE 'sqlite_%'")) return { toArray: () => [{ name: existingTable }] };
          return { toArray: () => [] };
        },
      },
    } as unknown as DurableObjectStorage;

    expect(() => initialize(storage)).toThrow(/unversioned.*fresh namespace/);
    expect(statements).toHaveLength(2);
    expect(statements.some((statement) => statement.startsWith("CREATE TABLE"))).toBe(false);
  });
});
