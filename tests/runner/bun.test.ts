import { expect, test } from "bun:test";

test("root Vitest battery", async () => {
  const run = Bun.spawn(["bun", "run", "test:battery"], {
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await run.exited;
  expect(exitCode).toBe(0);
}, 1_800_000);
