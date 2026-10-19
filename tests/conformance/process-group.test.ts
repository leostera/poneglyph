import assert from "node:assert/strict";
import {test} from "vitest";
import {parseProcessMembers, membersOfGroup} from "./process-group.js";
test("native process membership records safe identities and actual execution state", () => {
  assert.deepEqual(parseProcessMembers(" 123 10 123 S /usr/bin/node\n 124 123 123 Z /path/to/workerd\n"), [
    {pid: 123, parent: 10, group: 123, state: "S", command: "/usr/bin/node"},
    {pid: 124, parent: 123, group: 123, state: "Z", command: "/path/to/workerd"},
  ]);
  for (const text of ["garbage", "0 0 1 S node", "1 1 0 S node", "9007199254740992 1 2 S node"]) assert.throws(() => parseProcessMembers(text));
  for (const group of [0, -1, 0.5, process.pid]) assert.throws(() => membersOfGroup(group));
});
