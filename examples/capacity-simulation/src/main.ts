import { simulateCapacityEnvelope } from "../../../packages/poneglyph/src/storage/capacity-simulation.js";

export async function simulate(logicalBytes = 1_000_000_000_000, syntheticEntities = 10_000) {
  const result = await simulateCapacityEnvelope(logicalBytes, syntheticEntities);
  return { ...result, physicalPayloadBytesWritten: 0 as const };
}

export async function main(): Promise<void> {
  const logicalBytes = Number(process.argv[2] ?? "1000000000000");
  const syntheticEntities = Number(process.argv[3] ?? "10000");
  console.log(JSON.stringify(await simulate(logicalBytes, syntheticEntities), null, 2));
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
