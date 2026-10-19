export function parseReply(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("public reply must be a JSON object");
  return input as Record<string, unknown>;
}
export type ErrorEvidence = {name: string; message: string; stack?: string; code?: string; cause?: ErrorEvidence};
export function errorEvidence(input: unknown, depth = 0): ErrorEvidence {
  if (!(input instanceof Error)) return {name: "NonError", message: String(input)};
  const code: unknown = Reflect.get(input, "code");
  return {
    name: input.name, message: input.message, stack: input.stack,
    ...(typeof code === "string" ? {code} : {}),
    ...(input.cause !== undefined && depth < 4 ? {cause: errorEvidence(input.cause, depth + 1)} : {}),
  };
}
