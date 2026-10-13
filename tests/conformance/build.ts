import { build } from "esbuild";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const ROOT = dirname(fileURLToPath(import.meta.url));

export const implementations = [
  {name: "A", directory: "storage", ownerDepth: 0},
  {name: "B1", directory: "storage-candidate", ownerDepth: 4},
  ...["C", "D", "E", "F", "G", "H", "I", "J", "K"].map(name => ({name, directory: `storage-${name.toLowerCase()}`, ownerDepth: 4})),
] as const;
export type Implementation = (typeof implementations)[number];

// Compile-time selection only. Never edits the production selector or switches
// a backend inside a running namespace. Benchmark build/driver remain separate.
export async function buildConformance(implementation: Implementation, output: string) {
  await mkdir(output, {recursive: true});
  const inputs = new Map<string, string>();
  for (const name of ["application", "database"]) {
    const result = await build({
      entryPoints: [resolve(ROOT, `worker/${name}.ts`)],
      outfile: resolve(output, `${name}.mjs`), bundle: true, format: "esm",
      platform: "neutral", target: "es2022", external: ["cloudflare:workers"], metafile: true,
      define: {__E2E_OWNER_DEPTH__: String(implementation.ownerDepth)},
      plugins: [{name: "sole-conformance-implementation", setup(plugin) {
        plugin.onResolve({filter: /database-implementation\.js$/}, () => ({
          path: resolve(ROOT, `../../poneglyph/src/${implementation.directory}/implementation.ts`),
        }));
      }}],
    });
    for (const path of Object.keys(result.metafile.inputs)) inputs.set(path, hash(await readFile(path)));
  }
  const identity = identifyActorInputs([...inputs.keys()], implementation);
  const bundleDigests = Object.fromEntries(await Promise.all(["application", "database"].map(async name =>
    [name, hash(await readFile(resolve(output, `${name}.mjs`)))])));
  return {implementation: implementation.name, identity, sourceDigests: Object.fromEntries([...inputs].sort()), bundleDigests};
}
export function identifyActorInputs(inputs: readonly string[], selected: Implementation): string {
  const actors = inputs.flatMap(path => {
    const match = /(?:^|\/)src\/(storage(?:-[^/]+)?)\/(coordinator|shard)\.ts$/.exec(path.replaceAll("\\", "/"));
    return match ? [{directory: match[1]!, role: match[2]!}] : [];
  });
  for (const role of ["coordinator", "shard"]) {
    const directories = new Set(actors.filter(actor => actor.role === role).map(actor => actor.directory));
    assert.deepEqual([...directories], [selected.directory], `exact selected ${role} implementation, no mixed/unknown actors`);
  }
  return selected.directory;
}
function hash(bytes: Uint8Array) {return createHash("sha256").update(bytes).digest("hex");}
