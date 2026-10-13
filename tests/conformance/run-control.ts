import {errorEvidence} from "./response-evidence.js";
// Archival reads a file, not the live control object. Completion must be saved
// before that consumer can validate a terminal traversal.
export async function persistCompletion(control: RunControl, save: () => Promise<void>) {
  control.complete(); await save();
}
export type RunStage = Readonly<{implementation: string; phase: "build" | "startup" | "warm" | "restart" | "cold" | "cleanup"; caseName?: string}>;
export type RunFailure = Readonly<RunStage & {error: string; diagnostic: ReturnType<typeof errorEvidence>}>;
export class RunControl {
  readonly policy = "fail-fast";
  status: "running" | "complete" | "stopped" = "running";
  firstFailure: RunFailure | null = null;
  readonly cleanupFailures: RunFailure[] = [];
  stop(stage: RunStage, error: unknown) {
    if (this.status === "complete") throw new Error("completed run cannot accept a new failure");
    const failure = Object.freeze({...stage, error: String(error), diagnostic: errorEvidence(error)});
    if (this.firstFailure === null) this.firstFailure = failure;
    if (stage.phase === "cleanup") this.cleanupFailures.push(failure);
    this.status = "stopped";
  }
  requireRunning() {if (this.status !== "running") throw new Error("conformance stopped after its first unexpected failure");}
  complete() {this.requireRunning(); this.status = "complete";}
}
