import {describe, expect, it} from "vitest";
import * as worker from "../src/worker.js";
import {GraphCoordinatorDO, GraphLedgerDO, GraphTreeDO, GraphShardDO} from "../src/storage/implementation.js";
import {ensureLedgerSchema, ensureTreeSchema, ensureShardSchema} from "../src/storage/sql.js";
describe("canonical storage composition", () => {
  it("exports the four storage roles directly from the production Worker", () => {
    expect(worker.GraphCoordinatorDO).toBe(GraphCoordinatorDO);
    expect(worker.GraphLedgerDO).toBe(GraphLedgerDO);
    expect(worker.GraphTreeDO).toBe(GraphTreeDO);
    expect(worker.GraphShardDO).toBe(GraphShardDO);
  });
  it.each([ensureLedgerSchema, ensureTreeSchema, ensureShardSchema])("rejects incompatible persisted markers before any DDL", initialize => {
    const statements: string[] = [];
    const storage = {transactionSync: (callback: () => unknown) => callback(), sql: {exec(statement: string) {
      statements.push(statement);
      return {toArray: () => statement.includes("sqlite_master") ? [{name: "poneglyph_schema"}] : [{kind: "obsolete", version: 1}]};
    }}} as unknown as DurableObjectStorage;
    expect(() => initialize(storage)).toThrow(/refusing to reinterpret/);
    expect(statements.some(statement => statement.startsWith("CREATE") || statement.startsWith("INSERT"))).toBe(false);
  });
});
