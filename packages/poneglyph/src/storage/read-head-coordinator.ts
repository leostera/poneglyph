import {parseGraphId, type GraphId} from "../domain/graph-id.js";
import {isRecord} from "../domain/result.js";
import type {StorageEnv} from "./environment.js";
import {jsonResponse, readJsonBody} from "./http.js";
import {coordinatorObjectName} from "./keys.js";
import {ReadHeadJournal, ReadHeadJournalError, type ReadHeadPatch} from "./read-head-journal.js";
import {isReadHeadDeliveryPending, pendingReadHeadDeliveries, type ReadHeadDelivery} from "./read-head-parent.js";
import {readHeadReplicaName} from "./read-head-placement.js";
import {parseReadHeadCommand} from "./read-head-state.js";
import {readFailureReason} from "./read-diagnostics.js";

// Operational continuation budgets, not global active-read or replica ceilings.
const DELIVERY_BUDGET = 32, INVOCATION_BUDGET_MS = 5_000, DELIVERY_TIMEOUT_MS = 2_000;
function keys(raw: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(raw).length === expected.length && expected.every(key => Object.hasOwn(raw, key));
}
function counter(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0;
}

/** Serialized durable metadata work; ordinary facade reads never await this pump. */
export class ReadHeadCoordinator {
  private readonly journal: ReadHeadJournal;
  private pumping = false; // Optimization only; durable state carries authority/work.
  constructor(private readonly ctx: DurableObjectState, private readonly env: StorageEnv, invalidate: () => void) {
    this.journal = new ReadHeadJournal(ctx.storage, invalidate);
  }
  get enabled(): boolean { return this.journal.enabled; }
  async scheduleRecovery(): Promise<void> {
    if (this.journal.state?.operation != null) await this.ctx.storage.setAlarm(Date.now() + 1_000);
  }
  private assertRoot(graphId: GraphId): void {
    const parent = this.journal.state;
    if (parent !== null && parent.graphId !== graphId ||
        this.ctx.id.name !== undefined && this.ctx.id.name !== coordinatorObjectName(graphId)) {
      throw new ReadHeadJournalError(409, "read-head parent graph identity mismatch");
    }
  }
  private async deliver(delivery: ReadHeadDelivery): Promise<unknown> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const response = await this.env.GRAPH_FACADES.getByName(readHeadReplicaName(delivery.command.graphId, delivery.member)).fetch(
        "https://head.internal/_read-head-command", {method: "POST", signal: controller.signal,
          headers: {"content-type": "application/json"}, body: JSON.stringify({member: delivery.member, command: delivery.command})});
      if (!response.ok) { await response.body?.cancel(); throw new Error("Read-head delivery unavailable"); }
      const raw = await readJsonBody(response, 1_024);
      if (!raw.ok || !isRecord(raw.value) || !keys(raw.value, ["outcome"]) ||
          raw.value["outcome"] !== "applied" && raw.value["outcome"] !== "already-applied") throw new Error("Read-head delivery unconfirmed");
      return raw.value["outcome"];
    } finally { clearTimeout(timer); }
  }
  async pump(): Promise<void> {
    if (this.pumping || this.journal.state?.operation == null) return;
    this.pumping = true;
    try {
      // Recovery is durable BEFORE any remote head can freeze. Startup also
      // rearms pending journals using storage-only constructor initialization.
      await this.ctx.storage.setAlarm(Date.now() + 5_000);
      const started = Date.now();
      for (let issued = 0; issued < DELIVERY_BUDGET && Date.now() - started < INVOCATION_BUDGET_MS; issued++) {
        const parent = this.journal.state;
        if (parent?.operation == null) break;
        const delivery = pendingReadHeadDeliveries(parent)[0];
        if (delivery === undefined) throw new Error("Read-head pending journal has no delivery");
        const outcome = await this.deliver(delivery);
        // The journal rechecks CURRENT intent after the await, never a captured
        // pre-I/O state. Exact replay is projection recovery, not a fact retry.
        this.journal.acknowledge(delivery, outcome);
      }
    } catch (error) {
      // Never log arbitrary platform/backend messages, graph names or payloads.
      const operation = this.journal.state?.operation;
      const phase = operation?.kind === "publication" || operation?.kind === "join" ? operation.phase : operation?.kind ?? "idle";
      console.warn({event: "poneglyph.read_head.delivery_deferred", phase, reason: readFailureReason(error)});
    } finally {
      this.pumping = false;
      await this.scheduleRecovery();
    }
  }
  async publish(graphId: GraphId, patch: ReadHeadPatch): Promise<number> {
    this.assertRoot(graphId);
    this.journal.publish(graphId, patch);
    await this.pump();
    const parent = this.journal.state;
    if (parent === null || parent.operation !== null) throw new ReadHeadJournalError(423, "read-head publication is pending");
    return parent.view.frontier;
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return jsonResponse({error: "method not allowed"}, 405);
    const path = new URL(request.url).pathname;
    const raw = await readJsonBody(request, 8_192);
    if (!raw.ok || !isRecord(raw.value)) return jsonResponse({error: "invalid read-head coordination envelope"}, 400);
    try {
      if (path === "/_read-head-authorize") return this.authorize(raw.value);
      const graph = parseGraphId(raw.value["graphId"]);
      if (!graph.ok) return jsonResponse({error: "invalid read-head graph"}, 400);
      this.assertRoot(graph.value);
      if (path === "/_read-head-status" && keys(raw.value, ["graphId"])) {
        const parent = this.journal.state;
        const candidate = parent?.operation?.kind === "join" ? parent.operation.member : undefined;
        return jsonResponse({enabled: parent !== null, generation: parent?.generation ?? 0,
          members: parent?.members.filter(member => member !== candidate) ?? []});
      }
      if (path === "/_read-head-join" && keys(raw.value, ["graphId", "expectedGeneration"]) && counter(raw.value["expectedGeneration"])) {
        // First opt-in requires the canonical NAME, not an anonymous alias.
        if (!this.enabled && this.ctx.id.name !== coordinatorObjectName(graph.value)) {
          throw new ReadHeadJournalError(409, "read-head activation requires the named canonical facade");
        }
        const member = this.journal.join(graph.value, raw.value["expectedGeneration"]);
        await this.pump();
        const parent = this.journal.state;
        const pending = parent?.operation?.kind === "join" && parent.operation.member === member;
        return jsonResponse({member, generation: parent?.generation, pending}, pending ? 202 : 200);
      }
      if (path === "/_read-head-retire" && keys(raw.value, ["graphId", "member", "expectedGeneration"]) &&
          counter(raw.value["member"]) && counter(raw.value["expectedGeneration"])) {
        this.journal.retire(graph.value, raw.value["member"], raw.value["expectedGeneration"]);
        await this.pump();
        const pending = this.journal.state?.members.includes(raw.value["member"]) ?? false;
        return jsonResponse({member: raw.value["member"], pending}, pending ? 202 : 200);
      }
      return jsonResponse({error: "invalid read-head coordination request"}, 400);
    } catch (error) {
      return error instanceof ReadHeadJournalError ? jsonResponse({error: error.message, retryable: error.status === 423}, error.status) :
        jsonResponse({error: "read-head coordination is unavailable", retryable: true}, 503);
    }
  }
  private authorize(raw: Record<string, unknown>): Response {
    if (!keys(raw, ["member", "command"]) || !counter(raw["member"]) || raw["member"] < 1) {
      return jsonResponse({error: "invalid read-head command identity"}, 400);
    }
    let delivery: ReadHeadDelivery;
    try { delivery = {member: raw["member"], command: parseReadHeadCommand(raw["command"])}; }
    catch { return jsonResponse({error: "invalid read-head command"}, 400); }
    this.assertRoot(delivery.command.graphId);
    const parent = this.journal.state;
    return jsonResponse({authorized: parent !== null && isReadHeadDeliveryPending(parent, delivery)});
  }
}
