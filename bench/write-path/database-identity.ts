// Derive identity from actual bundled actors, never from a workload flag.
export function identifyDatabaseImplementation(inputs: readonly string[]): string {
  const paths = inputs.map(path => path.replaceAll("\\", "/"));
  for (const role of ["coordinator", "shard"]) {
    const actors = paths.flatMap(path => {
      const match = new RegExp(`(?:^|/)src/(storage(?:-[^/]+)?)/${role}\\.ts$`).exec(path);
      return match ? [match[1]!] : [];
    });
    if (new Set(actors).size !== 1 || actors[0] !== "storage") throw new Error(`database bundle requires exactly the canonical ${role}`);
  }
  return "poneglyph-pooled-owner-write-path";
}
