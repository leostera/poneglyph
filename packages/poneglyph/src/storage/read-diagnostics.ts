// Closed diagnostic vocabulary only. Backend messages may contain query values,
// tokens or URLs: use them for classification, never return or log them here.
export type ReadFailureReason = "overloaded" | "disconnected" | "timeout" | "request-limit" | "protocol" | "unknown";
export type ReadFailureStage = "snapshot" | "evaluation" | "release";

export function readFailureReason(error: unknown): ReadFailureReason {
  if (!(error instanceof Error)) return "unknown";
  if ("overloaded" in error && error.overloaded === true) return "overloaded";
  if ("disconnected" in error && error.disconnected === true) return "disconnected";
  if (error.name === "AbortError" || error.name === "TimeoutError") return "timeout";
  if (/too many subrequests|subrequest limit|too many requests|request limit exceeded/i.test(error.message)) return "request-limit";
  if (/overloaded/i.test(error.message)) return "overloaded";
  if (/disconnected|connection reset|network connection lost/i.test(error.message)) return "disconnected";
  if (/timed out|timeout/i.test(error.message)) return "timeout";
  if (error.name === "PoneglyphProtocolError") return "protocol";
  return "unknown";
}

export function readFailureDiagnostic(stage: ReadFailureStage, error: unknown) {
  return {event: "poneglyph.read.failure" as const, stage, reason: readFailureReason(error)};
}
