import { isRecord } from "../domain/result.js";

export type ParticipantFailureCode =
  | "inactive-fact-retraction"
  | "participant-payload-conflict"
  | "participant-cancelled"
  | "participant-route-mismatch"
  | "participant-context-conflict"
  | "participant-capacity-limit"
  | "participant-entity-limit"
  | "participant-invalid-request"
  | "participant-validation-rejected"
  | "participant-conflict"
  | "participant-rejected"
  | "unclassified";

export function classifyParticipantFailure(status: number, body: unknown): ParticipantFailureCode {
  const message = typeof body === "string"
    ? body
    : isRecord(body) && typeof body["error"] === "string"
      ? body["error"]
      : "";

  if (message.includes("cannot retract an inactive fact tuple")) return "inactive-fact-retraction";
  if (message.includes("transaction ID was already used with a different participant payload")) return "participant-payload-conflict";
  if (message.includes("transaction was cancelled")) return "participant-cancelled";
  if (message.includes("outside its virtual-shard range") || message.includes("not a complete ordered local batch")) {
    return "participant-route-mismatch";
  }
  if (message.includes("authority/identity context") || message.includes("context binding mismatch")) {
    return "participant-context-conflict";
  }
  if (message.includes("per-DO accounted capacity limit exceeded")) return "participant-capacity-limit";
  if (message.includes("exceeds") && (message.includes("active fact tuples") || message.includes("projected fields"))) {
    return "participant-entity-limit";
  }
  if (status === 400) return "participant-invalid-request";
  if (status === 409) return "participant-conflict";
  if (status === 413) return "participant-capacity-limit";
  if (status === 422) return "participant-validation-rejected";
  if (status >= 400 && status < 500) return "participant-rejected";
  return "unclassified";
}
