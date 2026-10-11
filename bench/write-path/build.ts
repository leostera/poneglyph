import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const ROOT = fileURLToPath(new URL(".", import.meta.url));
export async function buildWorkers() {
  const output = resolve(ROOT, ".build");
  await mkdir(output, { recursive: true });
  const sources = new Map<string, string>();
  for (const name of ["application", "database"]) {
    const result = await build({
      entryPoints: [resolve(ROOT, `worker/${name}.ts`)], outfile: resolve(output, `${name}.mjs`),
      bundle: true, format: "esm", platform: "neutral", target: "es2022", external: ["cloudflare:workers"],
      metafile: true,
    });
    for (const path of Object.keys(result.metafile.inputs).sort()) {
      const bytes = await readFile(path);
      sources.set(path, createHash("sha256").update(bytes).digest("hex"));
    }
  }
  for (const file of ["build.ts", "run.ts", "driver.ts", "ledger.ts", "stream-audit.ts", "final-result.ts", "runtime.ts", "corpus.ts", "scenarios.ts", "package.json", "pnpm-lock.yaml"]) {
    sources.set(file, createHash("sha256").update(await readFile(resolve(ROOT, file))).digest("hex"));
  }
  const manifest = {
    databaseImplementation: [...sources.keys()].some(path => path.replaceAll("\\", "/").endsWith("/storage-candidate/coordinator.ts"))
      ? "B1-independent-subtrees" : "A-central-coordinator-correctness",
    gitBase: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    gitStatus: execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n"),
    sourceDigests: Object.fromEntries([...sources].sort()),
    bundleDigests: Object.fromEntries(await Promise.all(["application", "database"].map(async name =>
      [name, createHash("sha256").update(await readFile(resolve(output, `${name}.mjs`))).digest("hex")]))),
    runtime: { miniflare: "5.20261006.1-alpha", compatibilityDate: "2026-10-06", node: process.version },
    clientPackage: "@leostera/poneglyph@0.1.0 (local packed file dependency)",
  };
  await writeFile(resolve(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildWorkers();
