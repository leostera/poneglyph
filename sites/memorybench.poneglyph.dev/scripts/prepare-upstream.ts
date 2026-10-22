import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
const checkout = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: tsx scripts/prepare-upstream.ts CHECKOUT");
const pin = "063b86bfb347336def3a084153f40bfea1e2dfd6";
const git = (...args: string[]) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
if (git("rev-parse", "HEAD").trim() !== pin) throw new Error("Wrong MemoryBench revision");
const patch = resolve(import.meta.dirname, "../integration/memorybench.patch");
try { git("apply", "--check", patch); git("apply", patch); }
catch { git("apply", "--reverse", "--check", patch); }
if (git("diff", "--", "src") !== readFileSync(patch, "utf8")) throw new Error("Unexpected upstream source modifications");
function generated(path: string, content: string) {
  if (existsSync(path) && readFileSync(path, "utf8") !== content) throw new Error(`Refusing to replace unrelated file: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
const providerDirectory = resolve(checkout, "src/providers/poneglyph");
let providerPath = relative(providerDirectory, resolve(import.meta.dirname, "../bench/provider.ts"));
if (!providerPath.startsWith(".")) providerPath = `./${providerPath}`;
generated(resolve(providerDirectory, "index.ts"), `// Generated local adapter registration; source stays in Poneglyph.\nexport { PoneglyphDeterministicProvider, PoneglyphExtractedProvider } from ${JSON.stringify(providerPath)};\n`);
generated(resolve(checkout, "src/utils/cloudflare.ts"), readFileSync(resolve(import.meta.dirname, "../integration/cloudflare.ts"), "utf8"));
generated(resolve(checkout, "tsconfig.poneglyph.json"), JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { noEmit: true, allowImportingTsExtensions: true, rootDir: resolve(import.meta.dirname, "../../../..") } }, null, 2) + "\n");
console.log(JSON.stringify({ commit: pin, patched: true, providers: ["poneglyph-a", "poneglyph-b"] }));
