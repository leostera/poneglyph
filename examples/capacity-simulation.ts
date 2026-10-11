import { simulateCapacityEnvelope } from "../poneglyph/src/storage/capacity-simulation.ts";

const logicalBytes = Number(process.argv[2] ?? "1000000000000");
const syntheticEntities = Number(process.argv[3] ?? "10000");

void simulateCapacityEnvelope(logicalBytes, syntheticEntities).then((result) => {
  console.log(JSON.stringify({ ...result, physicalPayloadBytesWritten: 0 }, null, 2));
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
