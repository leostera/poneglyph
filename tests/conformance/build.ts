import {build} from "esbuild";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
export const ROOT = dirname(fileURLToPath(import.meta.url));
export const implementation = {name: "poneglyph", directory: "storage", ownerDepth: 4} as const;

// Build the actual production composition, without aliases, selectors or a
// replacement authority module. The oracle remains independent of this code.
export async function buildConformance(output: string) {
  await mkdir(output, {recursive: true});
  const inputs = new Map<string, string>();
  for (const name of ["application", "database"]) {
    const result = await build({
      entryPoints: [resolve(ROOT, `worker/${name}.ts`)], outfile: resolve(output, `${name}.mjs`),
      bundle: true, format: "esm", platform: "neutral", target: "es2022",
      external: ["cloudflare:workers"], metafile: true,
    });
    for (const path of Object.keys(result.metafile.inputs)) inputs.set(path, hash(await readFile(path)));
  }
  const identity = identifyActorInputs([...inputs.keys()]);
  const bundleDigests = Object.fromEntries(await Promise.all(["application", "database"].map(async name =>
    [name, hash(await readFile(resolve(output, `${name}.mjs`)))])));
  return {implementation: implementation.name, identity, sourceDigests: Object.fromEntries([...inputs].sort()), bundleDigests};
}
export function identifyActorInputs(inputs: readonly string[]): string {
  const actors = inputs.flatMap(path => {
    const match = /(?:^|\/)src\/(storage(?:-[^/]+)?)\/(coordinator|shard)\.ts$/.exec(path.replaceAll("\\", "/"));
    return match ? [{directory: match[1]!, role: match[2]!}] : [];
  });
  for (const role of ["coordinator", "shard"]) {
    const directories = new Set(actors.filter(actor => actor.role === role).map(actor => actor.directory));
    assert.deepEqual([...directories], ["storage"], `canonical ${role}, no obsolete/mixed actors`);
  }
  return "poneglyph-pooled-owner-write-path";
}
function hash(bytes: Uint8Array) {return createHash("sha256").update(bytes).digest("hex");}
