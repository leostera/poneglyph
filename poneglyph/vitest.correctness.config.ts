import {fileURLToPath} from "node:url";
import {mergeConfig} from "vitest/config";
import base from "./vitest.config.js";

// Static test-build selection. No production selector edits or live backend
// switches; the selected controlled suite still proves actual class identity.
const implementations: Record<string, string> = {A: "storage", B1: "storage-candidate", C: "storage-c", D: "storage-d", E: "storage-e", F: "storage-f", G: "storage-g", H: "storage-h", I: "storage-i", J: "storage-j", K: "storage-k"};
const name = process.env["PONEGLYPH_CORRECTNESS_IMPLEMENTATION"];
if (!name || !Object.hasOwn(implementations, name)) throw new Error("explicit known correctness implementation required");
const controlled: Record<string, string[]> = {
  A: ["storage-implementation", "write-correctness", "distributed-storage", "todo"],
  B1: ["candidate-concurrency"], C: ["c-ledger"], D: ["d-conflicts"], E: ["e-atomic"], F: ["f-planning"],
  G: ["g-integrated"], H: ["h-routing"], I: ["i-maintenance"], J: ["j-admission"], K: ["k-key-reuse"],
};
// These are supplemental implementation-private fixtures, NOT the shared E2E
// suite. A-only global-coordinator SQL/split fixtures are invalid against G.
// Keep their selection explicit; tests/conformance always runs every backend.
const shared = ["client", "fact-model", "datalog", "capacity", "schema-compatibility"];
export default mergeConfig(base, {
  resolve: {alias: [{find: /^.*database-implementation\.js$/, replacement: fileURLToPath(new URL(`./src/${implementations[name]}/implementation.ts`, import.meta.url))}]},
  test: {include: [...shared, ...controlled[name]!].map(file => `tests/${file}.test.ts`)},
});
