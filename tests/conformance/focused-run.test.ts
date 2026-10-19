import {spawn} from "node:child_process";
import {resolve} from "node:path";
import {expect, test} from "vitest";

const root = resolve(import.meta.dirname, "../..");
const runFocused = process.env["PONEGLYPH_RUN_FOCUSED"] === "1";

test.skipIf(!runFocused)("focused correctness regressions against the disk-backed production Worker", async () => {
  expect(await runFocusedConformance()).toBe(0);
}, 3_600_000);

function runFocusedConformance(): Promise<number> {
  return new Promise((resolveCode, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", resolve(import.meta.dirname, "run-focused.ts")], {
      cwd: root,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", code => resolveCode(code ?? 1));
  });
}
