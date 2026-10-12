const IMPLEMENTATIONS = [
  {directory: "storage", identity: "A-central-coordinator-correctness"},
  {directory: "storage-candidate", identity: "B1-independent-subtrees"},
  {directory: "storage-c", identity: "C-pooled-coordinator-ledgers"},
  {directory: "storage-d", identity: "D-narrower-conflict-locks"},
  {directory: "storage-e", identity: "E-idempotent-local-commit"},
  {directory: "storage-f", identity: "F-shorter-critical-sections"},
  {directory: "storage-g", identity: "G-integrated-write-path"},
  {directory: "storage-h", identity: "H-epoch-fenced-route-cache"},
] as const;

// Identity follows actual bundled implementation classes, not a request flag
// or a label supplied independently of source composition.
export function identifyDatabaseImplementation(inputs: readonly string[]): string {
  const paths = inputs.map(path => path.replaceAll("\\", "/"));
  const matches = IMPLEMENTATIONS.filter(model => paths.some(path => path.endsWith(`/src/${model.directory}/coordinator.ts`)));
  if (matches.length !== 1) throw new Error("database bundle must contain exactly one known coordinator implementation");
  return matches[0]!.identity;
}
