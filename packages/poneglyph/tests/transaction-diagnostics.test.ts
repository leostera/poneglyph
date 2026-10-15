import { describe, expect, it } from "vitest";
import { classifyParticipantFailure } from "../src/storage/transaction-diagnostics.js";

describe("transaction failure diagnostics", () => {
  it("classifies known participant rejection reasons without returning their raw text", () => {
    const cases = [
      [422, { error: "cannot retract an inactive fact tuple for entity private:entity" }, "inactive-fact-retraction"],
      [409, { error: "transaction ID was already used with a different participant payload" }, "participant-payload-conflict"],
      [409, { error: "transaction was cancelled" }, "participant-cancelled"],
      [409, { error: "participant received a fact outside its virtual-shard range" }, "participant-route-mismatch"],
      [413, { error: "per-DO accounted capacity limit exceeded (123 bytes)" }, "participant-capacity-limit"],
      [422, { error: "unsupported fact" }, "participant-validation-rejected"],
      [500, { error: "private stack with transaction ID" }, "unclassified"],
    ] as const;

    for (const [status, body, expected] of cases) {
      const reason = classifyParticipantFailure(status, body);
      expect(reason).toBe(expected);
      expect(reason).not.toContain("private");
      expect(reason).not.toContain("entity");
    }
  });

  it("uses status-only fallbacks when the participant body is not parseable", () => {
    expect(classifyParticipantFailure(400, "not-json with private detail")).toBe("participant-invalid-request");
    expect(classifyParticipantFailure(409, undefined)).toBe("participant-conflict");
    expect(classifyParticipantFailure(413, null)).toBe("participant-capacity-limit");
    expect(classifyParticipantFailure(503, "private message")).toBe("unclassified");
  });
});
