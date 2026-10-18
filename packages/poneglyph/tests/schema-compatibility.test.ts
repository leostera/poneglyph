import { describe, expect, it } from "vitest";
import { ensureFacadeSchema, ensureLedgerSchema, ensureTreeSchema, ensureShardSchema } from "../src/storage/sql.js";

type SchemaInitializer = (storage: DurableObjectStorage) => void;

const initializers: readonly Readonly<{
  kind: string;
  existingTable: string;
  initialize: SchemaInitializer;
}>[] = [
  {kind: "facade", existingTable: "graph_safe_vector", initialize: ensureFacadeSchema},
  { kind: "ledger", existingTable: "candidate_transactions", initialize: ensureLedgerSchema },
  { kind: "tree", existingTable: "graph_state", initialize: ensureTreeSchema },
  { kind: "shard", existingTable: "shard_identity", initialize: ensureShardSchema },
];

describe("Durable Object schema compatibility", () => {
  it.each([{version: 2, accepted: true}, {version: 3, accepted: false}])(
    "rollback accepts facade 2 only: persisted version $version, accepted=$accepted",
    ({version, accepted}) => {
      const statements: string[] = [];
      const storage = {
        transactionSync: (callback: () => unknown) => callback(),
        sql: {exec: (statement: string) => {
          statements.push(statement);
          if (statement.includes("sqlite_master")) return {toArray: () => [{name: "poneglyph_schema"}]};
          if (statement === "SELECT kind, version FROM poneglyph_schema WHERE singleton = 1") {
            return {toArray: () => [{kind: "g-facade", version}]};
          }
          throw new Error("Unexpected schema statement");
        }},
      } as unknown as DurableObjectStorage;
      if (accepted) expect(() => ensureFacadeSchema(storage)).not.toThrow();
      else expect(() => ensureFacadeSchema(storage)).toThrow("unsupported g-facade Durable Object schema marker; refusing to reinterpret persisted data");
      expect(statements).toHaveLength(2);
      expect(statements.every(statement => statement.startsWith("SELECT"))).toBe(true);
    },
  );
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
