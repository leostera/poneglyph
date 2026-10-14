import {test} from "node:test";
import assert from "node:assert/strict";
import {parseInspectionPage} from "./inspection-page.js";
test("remote directory parser produces exact binary router evidence", () => {
  assert.deepEqual(parseInspectionPage({children: ["00", "01"], rows: []}, "0", 0), {kind: "router", children: ["00", "01"]});
});
test("remote leaf parser preserves SQL scalars and cursor evidence", () => {
  assert.deepEqual(parseInspectionPage({children: [], rows: [{cursor: 2, entity: "test:a", retired: null}]}, "0", 1), {kind: "leaf", rows: [{cursor: 2, entity: "test:a", retired: null}]});
});
test("malformed directory evidence cannot turn into an empty successful audit", () => {
  for (const input of [null, {}, {children: [], rows: {}}, {children: ["wrong", "01"], rows: []}, {children: ["00", "01"], rows: [{cursor: 1}]}]) {
    assert.throws(() => parseInspectionPage(input, "0", 0));
  }
});
test("invalid scalar, duplicate/backward cursor and overlarge page fail at the boundary", () => {
  for (const rows of [[{cursor: 0}], [{cursor: 1.5}], [{cursor: 1}, {cursor: 1}], [{cursor: 1, hidden: {}}], [{cursor: 1, value: Infinity}], Array.from({length: 129}, (_, i) => ({cursor: i + 1}))]) {
    assert.throws(() => parseInspectionPage({children: [], rows}, "", 0));
  }
});
