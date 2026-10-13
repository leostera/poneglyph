export type WritePhase = "prepared" | "applied";
export type BarrierConfig = Readonly<{phase: WritePhase; txId: string}>;
export type BarrierStatus =
  | {state: "idle"}
  | {state: "armed"; config: BarrierConfig}
  | {state: "waiting"; config: BarrierConfig; path: string; hits: number; nativeStatus: number}
  | {state: "released"; config: BarrierConfig; path: string; hits: number; nativeStatus: number; outcome: "released" | "expired"}
  | {state: "rejected"; config: BarrierConfig; path: string; nativeStatus: number};
type Release = "released" | "expired";
type Waiting = {status: Extract<BarrierStatus, {state: "waiting"}>; done: Promise<Release>; release: () => void};

function record(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("expected barrier object");
  return input as Record<string, unknown>;
}
export function parseBarrierConfig(input: unknown): BarrierConfig {
  const object = record(input);
  const phase = object["phase"], txId = object["txId"];
  if (phase !== "prepared" && phase !== "applied") throw new Error("unknown write phase");
  if (typeof txId !== "string" || !/^tx:[a-zA-Z0-9-]+$/.test(txId)) throw new Error("expected absolute conformance transaction URI");
  return Object.freeze({phase, txId});
}
export function parseBarrierStatus(input: unknown): BarrierStatus {
  const object = record(input), state = object["state"];
  if (state === "idle") return {state};
  const config = parseBarrierConfig(object["config"]);
  if (state === "armed") return {state, config};
  const path = object["path"], nativeStatus = object["nativeStatus"];
  if (typeof path !== "string" || !matchesPhase(path, config.phase) || typeof nativeStatus !== "number" || !Number.isInteger(nativeStatus) || nativeStatus < 100 || nativeStatus > 599) throw new Error("invalid native barrier observation");
  if (state === "rejected") return {state, config, path, nativeStatus};
  const hits = object["hits"];
  if (typeof hits !== "number" || !Number.isSafeInteger(hits) || hits < 1 || nativeStatus < 200 || nativeStatus >= 300) throw new Error("invalid successful barrier hit");
  if (state === "waiting") return {state, config, path, hits, nativeStatus};
  const outcome = object["outcome"];
  if (state === "released" && (outcome === "released" || outcome === "expired")) return {state, config, path, hits, nativeStatus, outcome};
  throw new Error("unknown barrier state");
}
function matchesPhase(path: string, phase: WritePhase) {
  return phase === "prepared" ? path === "/_prepare" : path === "/_commit" || path === "/_atomic";
}

// Test-only reply barrier. Production work executes unchanged; no input is
// delivered by the control API. Every duplicate matching reply waits too, so
// recovery cannot accidentally bypass the controlled causal boundary.
export class WriteBarrier {
  private current: BarrierStatus = {state: "idle"};
  private waiting: Waiting | undefined;
  constructor(private readonly holdMs = 10_000) {}
  status(): BarrierStatus {return structuredClone(this.current);}
  arm(input: unknown) {
    const config = parseBarrierConfig(input);
    if (this.current.state !== "idle") throw new Error("barrier must be cleared before arming");
    this.current = {state: "armed", config};
    return this.status();
  }
  clear() {
    this.waiting?.release();
    this.waiting = undefined;
    this.current = {state: "idle"};
    return this.status();
  }
  release() {
    if (this.current.state !== "waiting" || !this.waiting) throw new Error("barrier has not reached its native phase");
    this.waiting.release();
    return this.status();
  }
  async intercept(request: Request, invoke: () => Promise<Response>): Promise<Response> {
    const before = this.current;
    const path = new URL(request.url).pathname;
    if ((before.state !== "armed" && before.state !== "waiting") || !matchesPhase(path, before.config.phase)) return invoke();
    const body: unknown = await request.clone().json();
    if (record(body)["txId"] !== before.config.txId) return invoke();
    const response = await invoke();
    const observed: unknown = await response.clone().json();
    // Control may have been cleared/rearmed during either native await. A stale
    // request must never arm a replacement barrier, even with the same txId.
    if ((this.current.state !== "armed" && this.current.state !== "waiting") || this.current.config !== before.config) return response;
    const expected = before.config.phase === "prepared" ? "prepared" : "committed";
    if (!response.ok || record(observed)["status"] !== expected) {
      this.current = {state: "rejected", config: before.config, path, nativeStatus: response.status};
      return response;
    }
    if (!this.waiting) this.waiting = this.open(before.config, path, response.status);
    else this.waiting.status.hits++;
    await this.waiting.done;
    return response;
  }
  private open(config: BarrierConfig, path: string, nativeStatus: number): Waiting {
    const status: Waiting["status"] = {state: "waiting", config, path, nativeStatus, hits: 1};
    this.current = status;
    let finish!: (reason: Release) => void;
    const done = new Promise<Release>(resolve => {finish = resolve;});
    const settle = (outcome: Release) => {
      clearTimeout(timer);
      if (this.current === status) this.current = {...status, state: "released", outcome};
      finish(outcome);
    };
    // This safety release is a FAILED fixture outcome, not an implicit recovery
    // retry or permission to claim a controlled phase was exercised.
    const timer = setTimeout(() => settle("expired"), this.holdMs);
    return {status, done, release: () => settle("released")};
  }
}
