import { createHash } from "node:crypto";
import { parseFactDraft, type FactDraft } from "@leostera/poneglyph";
import type { GraphScope } from "../src/registry.js";

export interface Message { role: "user" | "assistant"; content: string; timestamp?: string; speaker?: string }
export interface Session { sessionId: string; messages: Message[]; metadata?: Record<string, unknown> }
export type EvidenceMessage = Readonly<{ id: string; role: string; content: string; speaker?: string; timestamp?: string }>;
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const messageId = (sessionId: string, index: number) => `memory:message:${digest(`${sessionId}:${index}`)}`;
export function evidenceMessages(session: Session): EvidenceMessage[] {
  if (!session.sessionId || !Array.isArray(session.messages)) throw new Error("Invalid session");
  return session.messages.map((message, index) => {
    if ((message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") throw new Error("Invalid message");
    if (message.speaker !== undefined && typeof message.speaker !== "string") throw new Error("Invalid speaker");
    if (message.timestamp !== undefined && typeof message.timestamp !== "string") throw new Error("Invalid timestamp");
    return { id: messageId(session.sessionId, index), role: message.role, content: message.content,
      ...(message.speaker !== undefined ? { speaker: message.speaker } : {}), ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}) };
  });
}
function fact(scope: GraphScope, entity: string, field: string, value: unknown): FactDraft {
  const parsed = parseFactDraft({ source: `memorybench:${scope.datasetHash}:${scope.variant}`, entity, field: `memory:${field}`, value, retraction: false });
  if (!parsed.ok) throw new Error(`Invalid shaped fact: ${parsed.error.message}`);
  return parsed.value;
}
const text = (value: string) => ({ type: "text", value });
export function rawFacts(scope: GraphScope, session: Session): FactDraft[] {
  const sessionEntity = `memory:session:${digest(session.sessionId)}`;
  const facts = [fact(scope, sessionEntity, "kind", text("session")), fact(scope, sessionEntity, "session_id", text(session.sessionId))];
  for (const key of ["date", "formattedDate"] as const) {
    const value = session.metadata?.[key];
    if (value !== undefined) {
      if (typeof value !== "string") throw new Error("Invalid session date");
      facts.push(fact(scope, sessionEntity, key === "date" ? "date" : "formatted_date", text(value)));
    }
  }
  for (const [index, message] of evidenceMessages(session).entries()) {
    facts.push(fact(scope, message.id, "kind", text("message")), fact(scope, message.id, "session", { type: "reference", value: sessionEntity }),
      fact(scope, message.id, "ordinal", { type: "number", value: String(index) }), fact(scope, message.id, "role", text(message.role)), fact(scope, message.id, "text", text(message.content)));
    for (const key of ["speaker", "timestamp"] as const) if (message[key] !== undefined) facts.push(fact(scope, message.id, key, text(message[key])));
  }
  return facts;
}
export function claimFacts(scope: GraphScope, chunkKey: string, input: unknown, evidence: readonly EvidenceMessage[]): FactDraft[] {
  if (!Array.isArray(input) || input.length > 300) throw new Error("Expected at most 300 extracted claims");
  const validIds = new Set(evidence.map(m => m.id));
  return input.flatMap((raw: unknown, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Invalid claim");
    const record = raw as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "evidence,object,predicate,subject") throw new Error("Unknown claim fields");
    const subject = record.subject, predicate = record.predicate, object = record.object, refs = record.evidence;
    if (typeof subject !== "string" || !subject || typeof predicate !== "string" || !predicate || typeof object !== "string" || !object || !Array.isArray(refs) || refs.length === 0 || refs.some(ref => typeof ref !== "string" || !validIds.has(ref))) throw new Error("Ungrounded or malformed claim");
    const id = `memory:claim:${digest(`${chunkKey}:${index}`)}`;
    return [fact(scope, id, "kind", text("claim")), fact(scope, id, "subject", text(subject)), fact(scope, id, "predicate", text(predicate)), fact(scope, id, "object", text(object)),
      ...[...new Set<string>(refs)].map(ref => fact(scope, id, "evidence", { type: "reference", value: ref }))];
  });
}
export function batches(facts: readonly FactDraft[]): FactDraft[][] {
  const result: FactDraft[][] = [];
  let batch: FactDraft[] = [];
  for (const fact of facts) {
    if (Buffer.byteLength(JSON.stringify([fact])) > 400_000) throw new Error("A single fact exceeds the batch byte budget");
    if (batch.length >= 100 || Buffer.byteLength(JSON.stringify([...batch, fact])) > 400_000) { result.push(batch); batch = []; }
    batch.push(fact);
  }
  if (batch.length) result.push(batch);
  return result;
}
export function chunks(messages: readonly EvidenceMessage[]): EvidenceMessage[][] {
  const result: EvidenceMessage[][] = [];
  let chunk: EvidenceMessage[] = [];
  for (const message of messages) {
    if (JSON.stringify(message).length > 96_000) throw new Error("Message exceeds extraction chunk budget; no silent truncation");
    if (chunk.length >= 20 || JSON.stringify([...chunk, message]).length > 96_000) { result.push(chunk); chunk = []; }
    chunk.push(message);
  }
  if (chunk.length) result.push(chunk);
  return result;
}
