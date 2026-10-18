import {describe, expect, it} from "vitest";
import {parseDatalogQuery} from "../src/datalog/parser.js";
import {QueryResultLimitExceeded} from "../src/datalog/evaluator.js";
import type {FactSource, FactTuple} from "../src/datalog/fact-source.js";
import {QueryScanBudgetExceeded} from "../src/datalog/scan-stream.js";
import {MAX_QUERY_RESPONSE_BYTES, MAX_QUERY_RESULTS} from "../src/storage/constants.js";
import {collectQueryRows} from "../src/storage/query-results.js";

const parsed = parseDatalogQuery("test:field(E, V)");
if (!parsed.ok) throw new Error("Invalid test query");
const query = parsed.value;
const tuple: FactTuple = {entity: {type: "string", value: "test:e"}, value: {type: "string", value: "海"}};
const signal = () => new AbortController().signal;

function source(rows: readonly FactTuple[]): FactSource {
  return {async *scan() {yield* rows;}};
}

describe("complete query materialization shared by HTTP and RPC", () => {
  it("preserves duplicate rows and exact typed values", async () => {
    const integer: FactTuple = {...tuple, value: {type: "integer", value: "9007199254740993"}};
    expect(await collectQueryRows(query, source([tuple, tuple, integer]), signal())).toEqual([
      {E: tuple.entity, V: tuple.value}, {E: tuple.entity, V: tuple.value}, {E: integer.entity, V: integer.value},
    ]);
  });

  it("returns a complete empty bag", async () => {
    expect(await collectQueryRows(query, source([]), signal())).toEqual([]);
  });

  it("does not return partial rows when a producer fails, even with an undefined reason", async () => {
    const broken: FactSource = {async *scan() {yield tuple; throw undefined;}};
    await expect(collectQueryRows(query, broken, signal())).rejects.toBeUndefined();
  });

  it("enforces UTF-8 byte limits and closes the producer on rejection", async () => {
    let closed = false;
    const oversized: FactSource = {async *scan() {
      try {yield {...tuple, value: {type: "string", value: "海".repeat(Math.ceil(MAX_QUERY_RESPONSE_BYTES / 3))}};}
      finally {closed = true;}
    }};
    await expect(collectQueryRows(query, oversized, signal())).rejects.toBeInstanceOf(QueryScanBudgetExceeded);
    expect(closed).toBe(true);
  });

  it("retains the evaluator result cap instead of truncating success", async () => {
    await expect(collectQueryRows(query, source(Array.from({length: MAX_QUERY_RESULTS + 1}, () => tuple)), signal()))
      .rejects.toBeInstanceOf(QueryResultLimitExceeded);
  });

  it("propagates cancellation rather than returning an empty success", async () => {
    const controller = new AbortController();
    controller.abort(new Error("controlled cancellation"));
    await expect(collectQueryRows(query, source([tuple]), controller.signal)).rejects.toThrow("controlled cancellation");
  });
});
