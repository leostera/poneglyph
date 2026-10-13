export function parseAuthorityIdentities(input: unknown): readonly string[] {
  if (!Array.isArray(input) || input.length > 128) throw new Error("bounded authority identity list required");
  const ids: string[] = [];
  for (const value of input) {
    if (typeof value !== "string" || value.length > 1024 || !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) throw new Error("authority identity must be an absolute URI");
    ids.push(value);
  }
  return Object.freeze(ids);
}
