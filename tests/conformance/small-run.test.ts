import {spawn} from "node:child_process";
import {resolve} from "node:path";
import {expect, test} from "vitest";

const root = resolve(import.meta.dirname, "../..");

test("small correctness scenarios against the disk-backed production Worker", async () => {
  expect(await runConformance()).toBe(0);
}, 3_600_000);

function runConformance(): Promise<number> {
  return new Promise((resolveCode, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", resolve(import.meta.dirname, "run.ts")], {
      cwd: root,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", code => resolveCode(code ?? 1));
  });
}
