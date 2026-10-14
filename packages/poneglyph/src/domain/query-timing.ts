// Coordinator elapsed wall time, not CPU or client/network round-trip time.
// Workers clocks advance at I/O boundaries; zero is valid for a short phase.
export type QueryTiming = Readonly<{
  executionMs: number;
  snapshotMs: number;
  evaluationMs: number;
  releaseMs: number;
}>;
