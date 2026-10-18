import { expect, test } from "bun:test";

test("root local correctness suite", async () => {
  const run = Bun.spawn(["bun", "run", "test:local:correctness"], {
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await run.exited;
  expect(exitCode).toBe(0);
}, 1_800_000);
