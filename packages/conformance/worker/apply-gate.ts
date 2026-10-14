import {correctnessBudgets} from "../contract.js";
import {parseReply} from "../response-evidence.js";
export type ApplyGateStatus =
  | {state: "idle"}
  | {state: "armed"; txId: string}
  | {state: "waiting"; txId: string; path: "/_commit"; hits: number}
  | {state: "released"; txId: string; path: "/_commit"; hits: number; outcome: "released" | "expired"};
export function parseApplyGateId(input: unknown): string {
  const id = parseReply(input)["txId"];
  if (typeof id !== "string" || !/^tx:[a-zA-Z0-9-]+$/.test(id)) throw new Error("invalid conformance apply-gate identity");
  return id;
}
export function parseApplyGateStatus(input: unknown): ApplyGateStatus {
  const body = parseReply(input), state = body["state"];
  if (state === "idle") return {state};
  const txId = parseApplyGateId(body);
  if (state === "armed") return {state, txId};
  const hits = body["hits"];
  if (body["path"] !== "/_commit" || typeof hits !== "number" || !Number.isSafeInteger(hits) || hits < 1) throw new Error("invalid pre-apply observation");
  if (state === "waiting") return {state, txId, path: "/_commit", hits};
  const outcome = body["outcome"];
  if (state === "released" && (outcome === "released" || outcome === "expired")) return {state, txId, path: "/_commit", hits, outcome};
  throw new Error("invalid apply-gate state");
}
// Unlike a successful-reply barrier, this gate pauses an actual distributed
// commit request BEFORE native SQL. The fixture must additionally prove its
// participant is durably prepared with no applied facts; this is not a receipt.
export class ApplyGate {
  private current: ApplyGateStatus = {state: "idle"};
  private generation = Symbol();
  private waiting: {done: Promise<void>; release(): void} | undefined;
  constructor(private readonly holdMs: number = correctnessBudgets.replyBarrierSafetyMs) {}
  status() {return structuredClone(this.current);}
  arm(input: unknown) {
    const txId = parseApplyGateId(input);
    if (this.current.state !== "idle") throw new Error("apply gate requires explicit clear");
    this.generation = Symbol(); this.current = {state: "armed", txId}; return this.status();
  }
  clear() {this.generation = Symbol(); this.waiting?.release(); this.waiting = undefined; this.current = {state: "idle"}; return this.status();}
  release() {
    if (this.current.state !== "waiting" || !this.waiting) throw new Error("native request has not reached apply gate");
    this.waiting.release(); return this.status();
  }
  async intercept(request: Request, invoke: () => Promise<Response>) {
    const before = this.current, generation = this.generation;
    if ((before.state !== "armed" && before.state !== "waiting") || new URL(request.url).pathname !== "/_commit") return invoke();
    const body = parseReply(await request.clone().json());
    if (body["txId"] !== before.txId || this.generation !== generation) return invoke();
    if (!this.waiting) {
      const status: Extract<ApplyGateStatus, {state: "waiting"}> = {state: "waiting", txId: before.txId, path: "/_commit", hits: 1};
      this.current = status;
      let finish: () => void = () => {}; const done = new Promise<void>(resolve => {finish = resolve;});
      const settle = (outcome: "released" | "expired") => {
        clearTimeout(timer); if (this.current === status) this.current = {...status, state: "released", outcome}; finish();
      };
      const timer = setTimeout(() => settle("expired"), this.holdMs);
      this.waiting = {done, release: () => settle("released")};
    } else if (this.current.state === "waiting") this.current.hits++;
    await this.waiting.done;
    return invoke(); // Never invent commit/abort or deliver a replacement input.
  }
}
