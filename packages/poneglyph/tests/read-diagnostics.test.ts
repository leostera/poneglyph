import { describe, expect, it } from "vitest";
import { readFailureDiagnostic, readFailureReason } from "../src/storage/read-diagnostics.js";

describe("read failure diagnostics", () => {
  it("classifies platform flags before message heuristics", () => {
    expect(readFailureReason(Object.assign(new Error("private backend text"), {overloaded: true}))).toBe("overloaded");
    expect(readFailureReason(Object.assign(new Error("private backend text"), {disconnected: true}))).toBe("disconnected");
    expect(readFailureReason(new Error("Too many subrequests. fake-secret"))).toBe("request-limit");
    expect(readFailureReason(new DOMException("private backend text", "TimeoutError"))).toBe("timeout");
    expect(readFailureReason(new Error("Network connection lost."))).toBe("disconnected");
  });

  it("emits only allowlisted fields and never serializes errors, values, or causes", () => {
    const error = new Error("fake-secret-token https://private.example/query", {cause: {token: "fake-secret"}});
    expect(readFailureDiagnostic("evaluation", error)).toEqual({event: "poneglyph.read.failure", stage: "evaluation", reason: "unknown"});
    expect(JSON.stringify(readFailureDiagnostic("snapshot", {token: "fake-secret"}))).not.toContain("fake-secret");
  });
});
